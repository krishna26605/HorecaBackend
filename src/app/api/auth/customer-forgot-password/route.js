import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import dbConnect from "@/lib/db/connect";
import Customer from "@/lib/db/models/customer";
import { sendEmail } from "@/lib/mail";
import { logger } from "@/lib/logger";

const JWT_SECRET = process.env.JWT_SECRET;

export async function POST(req) {
  try {
    const body = await req.json();
    const { email } = body;

    if (!email || !email.trim()) {
      return NextResponse.json({ success: false, error: "Email is required" }, { status: 400 });
    }

    if (!JWT_SECRET) {
      return NextResponse.json({ success: false, error: "Server configuration error" }, { status: 500 });
    }

    await dbConnect();

    const customer = await Customer.findOne({ email: email.toLowerCase().trim() });
    if (!customer) {
      return NextResponse.json({ success: false, error: "This email address is not registered in our system." }, { status: 404 });
    }

    // Generate JWT token valid for 1 hour
    const token = jwt.sign(
      { customerId: customer._id.toString() },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    const frontendUrl = "https://horeca-user-end.vercel.app";
    const resetLink = `${frontendUrl}/change-password?token=${token}`;

    // Send password reset email
    const mailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="color: #0f172a;">Reset Your Unifoods Password</h2>
        <p style="color: #475569; line-height: 1.5;">You recently requested to reset your password for your Unifoods B2B account. Click the button below to set a new password:</p>
        <div style="margin: 24px 0; text-align: center;">
          <a href="${resetLink}" style="background-color: #d97706; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: inline-block;">Reset Password</a>
        </div>
        <p style="color: #64748b; font-size: 12px; margin-top: 32px;">This link will expire in 1 hour. If you did not request a password reset, please ignore this email.</p>
      </div>
    `;

    await sendEmail({
      to: customer.email,
      subject: "Reset Your Unifoods Account Password",
      html: mailHtml,
      text: `Reset your password by visiting this link: ${resetLink}`
    });

    await logger({
      level: "info",
      message: `Password reset link requested for customer: ${customer.email}`,
      action: "CUSTOMER_PASSWORD_RESET_REQUESTED",
      userId: customer._id,
      userModel: "Customer",
      req
    });

    return NextResponse.json({ success: true, message: "Password reset email sent successfully." });
  } catch (err) {
    console.error("Error in customer-forgot-password:", err);
    return NextResponse.json({ success: false, error: err.message || "Failed to process request" }, { status: 500 });
  }
}
