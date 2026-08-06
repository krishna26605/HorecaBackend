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
    const { token, newPassword } = body;

    if (!token || !newPassword) {
      return NextResponse.json({ success: false, error: "Missing token or password" }, { status: 400 });
    }

    if (!JWT_SECRET) {
      console.error("JWT_SECRET is not configured");
      return NextResponse.json({ success: false, error: "Server configuration error" }, { status: 500 });
    }

    // 1. Verify the JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      console.warn("Invalid or expired password reset token:", err.message);
      return NextResponse.json({ success: false, error: "Password change link is invalid or has expired. Please request a new one." }, { status: 401 });
    }

    const { customerId } = decoded;
    if (!customerId) {
      return NextResponse.json({ success: false, error: "Invalid token payload" }, { status: 400 });
    }

    await dbConnect();

    // 2. Find customer
    const customer = await Customer.findById(customerId);
    if (!customer) {
      return NextResponse.json({ success: false, error: "Customer account not found" }, { status: 404 });
    }

    // 3. Hash and update password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    customer.password = hashedPassword;
    await customer.save();

    await logger({
      level: "info",
      message: `Customer password updated: ${customer.username || customer.email}`,
      action: "CUSTOMER_PASSWORD_RESET",
      userId: customer._id,
      userModel: "Customer",
      req
    });

    return NextResponse.json({ success: true, message: "Password updated successfully. You can now login with your new password." });
  } catch (err) {
    console.error("Error resetting customer password:", err);
    return NextResponse.json({ success: false, error: err.message || "Failed to reset password" }, { status: 500 });
  }
}
