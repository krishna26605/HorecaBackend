// /models/Supplier.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const { Schema } = mongoose;

const supplierSchema = new Schema(
  {
    businessName: { type: String, required: [true, "Business Name is required"], trim: true },
    categories: [{ type: String, trim: true }],
    subcategories: [{ type: String, trim: true }],
    brand: { type: String, trim: true },
    ownerName: { type: String, trim: true },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address']
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters long"]
    },
    phone: { type: String },
    role: { type: String, default: "supplier" },

    businessType: {
      type: String
    },
    mathadiApplicable: { type: String, default: "No" },
    shopName: { type: String, trim: true },
    gstNumber: {
      type: String,
      trim: true,
      match: [/^$|^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Please enter a valid GST number format']
    },
    panNumber: { type: String, trim: true },

    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true },
      postalCode: { type: String, trim: true },
    },

    godownIncharge: {
      type: Schema.Types.ObjectId,
      ref: "Employee"
    },

    salesPersons: [{
      name: { type: String, required: true },
      email: {
        type: String,
        required: true,
        match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address']
      },
      phone: { type: String, required: true },
      position: { type: String, required: true }
    }],

    termsAndConditions: [{
      category: { type: String, default: "General" },
      terms: { type: String },
      expiryDate: { type: Date },
      documentUrl: { type: String },
      documentName: { type: String }
    }],


    bankDetails: {
      accountHolderName: { type: String },
      bankName: { type: String },
      accountNumber: { type: String },
      ifscCode: { type: String },
    },

    documents: { type: Array, default: [] },
    products: { type: Array, default: [] },

    poTemplateId: {
      type: Schema.Types.ObjectId,
      ref: "POTemplate"
    },
    claimTemplateId: {
      type: Schema.Types.ObjectId,
      ref: "ClaimTemplate"
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "active", "inactive", "blocked"],
      default: "pending"
    },
    verificationNotes: { type: String },
    verifiedAt: { type: Date },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "Admin" },

    passwordResetToken: { type: String },
    passwordResetExpires: { type: Date },

    phoneVerificationToken: { type: String },
    phoneVerificationExpires: { type: Date },
    isPhoneVerified: { type: Boolean, default: false },

    totalOrders: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    lastLogin: { type: Date }
  },
  { timestamps: true }
);

// Hash password before saving
supplierSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    const saltRounds = 10;
    this.password = await bcrypt.hash(this.password, saltRounds);
    next();
  } catch (err) {
    next(err);
  }
});

// Compare password method
supplierSchema.methods.isPasswordCorrect = async function (password) {
  return await bcrypt.compare(password, this.password);
};

// Generate access token
supplierSchema.methods.generateAccessToken = function () {
  return jwt.sign(
    { id: this._id, email: this.email, role: this.role },
    process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET || "fallback_access_token_secret",
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || "1d" }
  );
};

// Generate refresh token
supplierSchema.methods.generateRefreshToken = function () {
  return jwt.sign(
    { id: this._id },
    process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || "fallback_refresh_token_secret",
    { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || "7d" }
  );
};

// Password reset token helper
supplierSchema.methods.generatePasswordResetToken = function () {
  const resetToken = crypto.randomBytes(32).toString("hex");
  this.passwordResetToken = crypto.createHash("sha256").update(resetToken).digest("hex");
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
  return resetToken;
};

delete mongoose.models.Supplier;
const Supplier = mongoose.model("Supplier", supplierSchema);
export default Supplier;
