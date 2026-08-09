import mongoose from "mongoose";

const { Schema } = mongoose;

const imageSubSchema = new Schema({
  url: { type: String, required: true },
  publicId: { type: String, required: false },
  isMain: { type: Boolean, default: false },
}, { _id: false });

const productRequestSchema = new Schema(
  {
    supplierId: { 
      type: Schema.Types.ObjectId, 
      required: [true, "Supplier ID is required"], 
      ref: "Supplier" 
    },
    categoryId: { 
      type: Schema.Types.ObjectId, 
      ref: "Category" 
    },
    categoryName: {
      type: String, // fallback if categoryId is not provided
    },
    name: { 
      type: String, 
      required: [true, "Product name is required"], 
      trim: true, 
      index: true 
    },
    description: { 
      type: String, 
      trim: true 
    },
    sku: {
      type: String,
      trim: true
    },
    price: { 
      type: Number, 
      required: [true, "Price is required"], 
      min: [0, "Price cannot be negative"] 
    },
    unit: { 
      type: String, 
      enum: ["kg", "g", "liters", "ml", "pcs", "box", "dozen", "Kg", "Gram", "Liter", "Ml", "Piece", "Box", "Dozen", "Pack", "Ton"], 
      default: "Kg" 
    },
    stockQuantity: { 
      type: Number, 
      default: 0, 
      min: [0, "Stock quantity cannot be negative"] 
    },
    images: {
      type: [imageSubSchema],
      default: []
    },
    status: { 
      type: String, 
      enum: ["Pending", "Approved", "Rejected"], 
      default: "Pending" 
    },
    cctRemarks: { 
      type: String 
    }
  },
  { timestamps: true }
);

delete mongoose.models.ProductRequest;
const ProductRequest = mongoose.models.ProductRequest || mongoose.model("ProductRequest", productRequestSchema);

export default ProductRequest;


