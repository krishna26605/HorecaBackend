import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import Supplier from "@/lib/db/models/supplier";
import jwt from "jsonwebtoken";

const ACCESS_SECRET = process.env.ACCESS_TOKEN_SECRET || "fallback_access_token_secret";
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

export async function POST(request) {
  try {
    await dbConnect();
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: "Email and password are required" },
        { status: 400 }
      );
    }

    // Find supplier and explicitly include password field if it was excluded by default
    const supplier = await Supplier.findOne({ email: email.toLowerCase().trim() });
    
    if (!supplier) {
      return NextResponse.json(
        { success: false, error: "Invalid credentials" },
        { status: 401 }
      );
    }

    // Check if supplier is blocked or inactive
    if (["blocked", "rejected", "inactive"].includes(supplier.status)) {
      return NextResponse.json(
        { success: false, error: `Account is ${supplier.status}. Please contact support.` },
        { status: 403 }
      );
    }

    // Use the model method to check password
    const isMatched = await supplier.isPasswordCorrect(password);
    if (!isMatched) {
      return NextResponse.json(
        { success: false, error: "Invalid credentials" },
        { status: 401 }
      );
    }

    // Update last login
    try {
      await Supplier.updateOne({ _id: supplier._id }, { $set: { lastLogin: new Date() } });
    } catch (updateErr) {
      console.warn("Could not update supplier lastLogin:", updateErr);
    }

    // Generate token
    const token = supplier.generateAccessToken();

    // Prepare response data (excluding password)
    const supplierData = supplier.toObject();
    delete supplierData.password;

    // Set HTTP-Only Cookie
    const cookie = `authToken=${token}; Path=/; HttpOnly; Max-Age=${TOKEN_MAX_AGE}; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

    const response = NextResponse.json(
      { 
        success: true, 
        message: "Login successful", 
        data: supplierData,
        token 
      },
      { 
        status: 200,
        headers: { "Set-Cookie": cookie }
      }
    );

    return response;

  } catch (err) {
    console.error("Supplier Login Error:", err);
    return NextResponse.json(
      { success: false, error: "Internal Server Error", details: err.message },
      { status: 500 }
    );
  }
}
