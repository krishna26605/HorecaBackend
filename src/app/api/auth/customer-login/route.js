import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dbConnect from "@/lib/db/connect";
import Customer from "@/lib/db/models/customer";
import { logger } from "@/lib/logger";

const JWT_SECRET = process.env.JWT_SECRET;

export async function POST(req) {
  try {
    const body = await req.json();
    const { identifier, password } = body;

    if (!identifier || !password) {
      return NextResponse.json({ success: false, error: "Missing username/email or password" }, { status: 400 });
    }

    await dbConnect();

    // Normalize phone identifier lookup
    const cleanPhone = identifier.replace(/\D/g, "");
    const phoneVariants = [
      identifier.trim(),
      cleanPhone,
      cleanPhone ? `+91${cleanPhone}` : null,
      cleanPhone ? `+${cleanPhone}` : null
    ].filter(Boolean);

    // Find user by username, email, or phone
    const user = await Customer.findOne({
      $or: [
        { username: identifier.trim() },
        { email: identifier.trim().toLowerCase() },
        { phone: { $in: phoneVariants } }
      ]
    });

    if (!user) {
      return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 401 });
    }

    if (user.isVerified === false) {
      return NextResponse.json({ success: false, error: "Your account is pending approval by the Customer Care Team." }, { status: 403 });
    }

    // Check if user has a password set (legacy users might only have OTP)
    if (!user.password) {
      return NextResponse.json({ success: false, error: "Please use OTP to login or reset your password." }, { status: 401 });
    }

    // Verify password (supports bcrypt hash and plain text fallback with auto-hashing)
    let isMatch = false;
    try {
      isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch && password !== password.trim()) {
        isMatch = await bcrypt.compare(password.trim(), user.password);
      }
    } catch (err) {
      // Stored password is not a valid bcrypt hash, fallback to plain text comparison
      const cleanPass = password.trim();
      isMatch = password === user.password || cleanPass === user.password;
      if (isMatch) {
        // Auto-upgrade plain text password to bcrypt hash
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(cleanPass, salt);
        await user.save();
        console.log(`[Password Auto-Upgrade] Auto-hashed plain password for user: ${user.username || user.email}`);
      }
    }

    console.log("Login Debug - user:", user.email, "isMatch:", isMatch);

    if (!isMatch) {
      return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 401 });
    }

    // Update last login
    user.lastLoginAt = new Date();
    await user.save();

    await logger({ 
      level: 'info', 
      message: `Customer logged in: ${user.username || user.email}`, 
      action: 'CUSTOMER_LOGIN', 
      userId: user._id, 
      userModel: 'Customer', 
      metadata: { identifier }, 
      req 
    });

    // Create JWT
    const token = jwt.sign(
      { _id: user._id, phone: user.phone, category: user.category || "D", username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return NextResponse.json({
      success: true,
      data: {
        accessToken: token,
        user: {
          id: user._id,
          username: user.username,
          phone: user.phone,
          email: user.email,
          name: user.name,
          businessName: user.businessName,
          category: user.category,
          advanceBalance: user.advanceBalance || 0,
          cnBalance: user.cnBalance || 0
        },
      },
    });
  } catch (err) {
    console.error("🔥 CUSTOMER LOGIN ERROR:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}
