// // /models/Product.js
// import mongoose from "mongoose";

// const { Schema } = mongoose;

// const imageSubSchema = new Schema({
//   url: { type: String, required: true },
//   publicId: { type: String, required: true },
//   isMain: { type: Boolean, default: false },
// }, { _id: false });

// const variationSubSchema = new Schema({
//   name: { type: String }, // e.g., "Size"
//   value: { type: String }, // e.g., "500g"
//   additionalPrice: { type: Number, default: 0 },
//   stockQuantity: { type: Number, default: 0 }
// }, { _id: false });

// const productSchema = new Schema(
//   {
//     supplierId: { 
//       type: Schema.Types.ObjectId, 
//       required: [true, "Supplier ID is required"], 
//       ref: "Supplier" 
//     },
//     categoryId: { 
//       type: Schema.Types.ObjectId, 
//       required: [true, "Category ID is required"], 
//       ref: "Category" 
//     },
//     name: { type: String, required: [true, "Product name is required"], trim: true, index: true },
//     description: { type: String, trim: true },
//     price: { type: Number, required: [true, "Price is required"], min: [0, "Price cannot be negative"] },
//     gst: { type: Number, default: 0, min: [0, "GST cannot be negative"], max: [100, "GST cannot exceed 100%"] },
//     stockQuantity: { type: Number, required: [true, "Stock quantity is required"], min: [0, "Stock quantity cannot be negative"] },
//     unit: { type: String, enum: ["kg", "g", "liters", "ml", "pcs", "box", "dozen"], default: "kg" },
//     images: {
//       type: [imageSubSchema],
//       validate: {
//         validator: function(value) {
//           return Array.isArray(value) && value.length > 0;
//         },
//         message: 'At least one product image is required'
//       },
//       required: [true, 'Product images are required']
//     },
//     isActive: { type: Boolean, default: true },
//     discountedPrice: { 
//       type: Number, 
//       min: [0, "Discounted price cannot be negative"],
//       validate: {
//         validator: function(value) {
//           // allow undefined/null
//           if (value == null) return true;
//           return value <= this.price;
//         },
//         message: "Discounted price must be less than or equal to regular price"
//       }
//     },
//     offerPercentage: { type: Number, default: 0, min: [0, "Offer percentage cannot be negative"], max: [100, "Offer percentage cannot exceed 100"] },
//     offerStartDate: { type: Date },
//     offerEndDate: { type: Date },
//     hasActiveOffer: { type: Boolean, default: false },
//     variations: [variationSubSchema],
//     sku: { type: String, unique: true, sparse: true },
//     barcode: { type: String, unique: true, sparse: true },
//     expiryDate: { type: Date },
//     manufactureDate: { type: Date },
//     averageRating: { type: Number, default: 0, min: 0, max: 5 },
//     totalReviews: { type: Number, default: 0 },
//     isFeatured: { type: Boolean, default: false },
//     isTrending: { type: Boolean, default: false },
//     discountStartDate: { type: Date },
//     discountEndDate: { type: Date }
//   },
//   { timestamps: true }
// );

// // Pre-save hook: calculate offerPercentage & hasActiveOffer
// productSchema.pre("save", function (next) {
//   if (this.price > 0 && this.discountedPrice != null && !this.isModified('offerPercentage')) {
//     this.offerPercentage = ((this.price - this.discountedPrice) / this.price) * 100;
//   }

//   if (this.offerStartDate && this.offerEndDate) {
//     const now = new Date();
//     this.hasActiveOffer = now >= this.offerStartDate && now <= this.offerEndDate;
//   } else if (this.offerPercentage > 0) {
//     this.hasActiveOffer = true;
//   } else {
//     this.hasActiveOffer = false;
//   }

//   next();
// });

// // Virtual
// productSchema.virtual('inStock').get(function() {
//   return this.stockQuantity > 0;
// });

// // Method
// productSchema.methods.isDiscountActive = function() {
//   const now = new Date();
//   if (!this.discountStartDate || !this.discountEndDate) {
//     return !!this.discountedPrice;
//   }
//   return now >= this.discountStartDate && now <= this.discountEndDate;
// };

// // Avoid recompilation issues in Next dev
// const Product = mongoose.models.Product || mongoose.model("Product", productSchema);

// export default Product;


// /models/Product.js
import mongoose from "mongoose";
import { generateSKU } from "@/lib/utils/generateSKU";

const { Schema } = mongoose;

const imageSubSchema = new Schema({
  url: { type: String, required: true },
  publicId: { type: String, required: true },
  isMain: { type: Boolean, default: false },
}, { _id: false });

const variationSubSchema = new Schema({
  name: { type: String }, // e.g., "Size"
  value: { type: String }, // e.g., "500g"
  additionalPrice: { type: Number, default: 0 },
  stockQuantity: { type: Number, default: 0 },
  sku: { type: String, default: null }
}, { _id: false });

const productSchema = new Schema({
  supplierId: { type: Schema.Types.ObjectId, required: [true, "Supplier ID is required"], ref: "Supplier" },
  categoryId: { type: Schema.Types.ObjectId, ref: "Brand" },
  categoryName: { type: String, trim: true },
  subcategoryId: { type: Schema.Types.ObjectId, ref: "Brand" },
  name: { type: String, required: [true, "Product name is required"], trim: true, index: true },
  description: { type: String, trim: true },
  basePrice: { type: Number, default: 0, min: [0, "Base price cannot be negative"] },
  assuredMargin: { type: Number, default: 0, min: [0, "Assured margin cannot be negative"] },
  claimMargin: { type: Number, default: 0 },
  batchNumber: { type: String, default: null },
  shelfLife: { type: String, default: null },
  price: { type: Number, default: 0, min: [0, "Price cannot be negative"] },
  gst: { type: Number, default: 0, min: [0, "GST cannot be negative"], max: [100, "GST cannot exceed 100%"] },
  stockQuantity: { type: Number, default: 0, min: [0, "Stock quantity cannot be negative"] },
  moq: { type: Number, default: 0 },
  mov: { type: Number, default: 0 },
  unit: { type: String, enum: ["kg", "g", "liters", "ml", "pcs", "box", "dozen", "pack", "ton", "Kg", "Gram", "Liter", "Ml", "Piece", "Box", "Dozen", "Pack", "Ton", "Nos", "Ltr"], default: "Kg" },
  images: {
    type: [imageSubSchema],
    default: []
  },
  isColdStorage: { type: Boolean, default: false },
  temperature: { type: String, default: null },
  isActive: { type: Boolean, default: true },
  discountedPrice: {
    type: Number,
    min: [0, "Discounted price cannot be negative"],
    validate: {
      validator: function (value) {
        if (value == null) return true;
        return value <= this.price;
      },
      message: "Discounted price must be less than or equal to regular price"
    }
  },
  offerPercentage: { type: Number, default: 0, min: [0, "Offer percentage cannot be negative"], max: [100, "Offer percentage cannot exceed 100"] },
  offerStartDate: { type: Date },
  offerEndDate: { type: Date },
  hasActiveOffer: { type: Boolean, default: false },
  variations: [variationSubSchema],
  sku: { type: String, unique: true, sparse: true },
  barcode: { type: String, unique: true, sparse: true },
  expiryDate: { type: Date },
  manufactureDate: { type: Date },
  averageRating: { type: Number, default: 0, min: 0, max: 5 },
  totalReviews: { type: Number, default: 0 },
  isFeatured: { type: Boolean, default: false },
  isTrending: { type: Boolean, default: false },
  categoryPrices: {
    A: { type: Number, default: 0 },
    B: { type: Number, default: 0 },
    C: { type: Number, default: 0 }
  },
  discountStartDate: { type: Date },
  moq: { type: Number, default: 0 },
  poTemplateId: {
    type: Schema.Types.ObjectId,
    ref: "POTemplate"
  },
  claimTemplateId: {
    type: Schema.Types.ObjectId,
    ref: "ClaimTemplate"
  },
  locationId: { type: Schema.Types.ObjectId, ref: "WarehouseLocation" },
  locationName: { type: String },
  locationPath: { type: String }
}, { timestamps: true });

// Robust pre-save
productSchema.pre("save", function (next) {
  try {
    // Generate main SKU if missing
    if (!this.sku) {
      let prefix = "PRD";
      if (this.name) {
        const cleaned = this.name.replace(/[^A-Z0-9]/gi, "").slice(0, 3).toUpperCase();
        if (cleaned) prefix = cleaned;
      }
      this.sku = generateSKU(prefix);
    }

    // Ensure variations exist and assign SKUs in-place (avoid spreading subdocs)
    if (Array.isArray(this.variations)) {
      for (let i = 0; i < this.variations.length; i++) {
        const v = this.variations[i];
        if (!v) continue;
        if (!v.sku) {
          // variation prefix: <productPrefix><index>
          const rootPrefix = (this.sku && this.sku.split("-")[0]) ? this.sku.split("-")[0] : 'PRD';
          const vPrefix = `${rootPrefix}${i + 1}`;
          // set directly to the subdoc object so mongoose will save it
          this.variations[i].sku = generateSKU(vPrefix);
        }
      }
    }

    // Keep your original offer logic (unchanged)
    if (this.price > 0 && this.discountedPrice != null && !this.isModified('offerPercentage')) {
      this.offerPercentage = ((this.price - this.discountedPrice) / this.price) * 100;
    }

    if (this.offerStartDate && this.offerEndDate) {
      const now = new Date();
      this.hasActiveOffer = now >= this.offerStartDate && now <= this.offerEndDate;
    } else if (this.offerPercentage > 0) {
      this.hasActiveOffer = true;
    } else {
      this.hasActiveOffer = false;
    }

    return next();
  } catch (err) {
    // send error to next so Mongoose/Next API can respond
    return next(err);
  }
});

productSchema.virtual('inStock').get(function () {
  return this.stockQuantity > 0;
});

productSchema.methods.isDiscountActive = function () {
  const now = new Date();
  if (!this.discountStartDate || !this.discountEndDate) {
    return !!this.discountedPrice;
  }
  return now >= this.discountStartDate && now <= this.discountEndDate;
};
delete mongoose.models.Product;
const Product = mongoose.models.Product || mongoose.model("Product", productSchema);

export default Product;
