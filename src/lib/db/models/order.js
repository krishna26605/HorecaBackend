// /models/Order.js
/**
 * Single-file place for all order-related schemas & models:
 * - Order (with embedded invoice, payment, delivery, b2b, items)
 * - ReturnRequest (for return/refund/replacement workflows)
 *
 * Usage:
 *   import Order from "@/models/Order"; // default export Order
 *   import { ReturnRequest } from "@/models/Order";
 *
 * Note: replace product/supplier/user refs with your actual model names if different.
 */

import mongoose from "mongoose";
const { Schema } = mongoose;

/* ---------- Enums / constants ---------- */
const ORDER_STATUSES = [
  "pending",
  "processing",
  "confirmed",
  "Packaging",
  "packaging",
  "packed",
  "shipped",
  "out_for_delivery",
  "out_for_x`very", // Keep typo for backwards compatibility just in case
  "delivered",
  "cancelled",
  "returned",
  "refunded",
  "replacement_sent",
];

const PAYMENT_STATUSES = ["pending", "paid", "partially_paid", "failed", "refunded"];
const DELIVERY_STATUSES = [
  "pending",
  "out_for_delivery",
  "delivered",
  "failed",
  "cancelled",
];





/* ---------- Sub-schemas ---------- */

/* Order item: snapshot of product at time of ordering */
const OrderItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    sku: { type: String },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true },
    totalPrice: { type: Number, required: true },
    supplier: { type: Schema.Types.ObjectId, ref: "Supplier" }, // helpful for multi-supplier scenarios
    image: { type: String }, // Store product image URL (http or relative)
    gst: { type: Number, default: 0 }, // Store the GST percentage applied at time of order
    attributes: { type: Schema.Types.Mixed }, // e.g., color/size selected
    isColdStorageRequired: { type: Boolean, default: false },
    requestedTemperature: { type: String, default: null },
  },
  { _id: false }
);

/* Invoice metadata */
const InvoiceSchema = new Schema(
  {
    invoiceNumber: { type: String },
    generatedAt: { type: Date },
    url: { type: String }, // if you upload invoice PDF and store link
    status: { type: String, enum: ["optional", "verified"], default: "optional" },
    meta: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

/* Payment info */
const PaymentSchema = new Schema(
  {
    method: { type: String }, // e.g. bank_transfer, card, cod
    status: { type: String, enum: PAYMENT_STATUSES, default: "pending" },
    transactionId: { type: String },
    paidAt: { type: Date },
    paidAmount: { type: Number, default: 0 },
    balanceAmount: { type: Number, default: 0 },
    meta: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

/* Delivery assignment/status */
const DeliverySchema = new Schema(
  {
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" }, // delivery personnel user id
    assignedBy: { type: Schema.Types.ObjectId, ref: "User" }, // who assigned (admin/supplier)
    assignedAt: { type: Date },
    status: { type: String, enum: DELIVERY_STATUSES, default: "pending" },
    trackingNumber: { type: String },
    eta: { type: Date },
    lastLocation: { type: Schema.Types.Mixed }, // optional geo or location snapshot
    meta: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

/* B2B specific fields */
const B2BSchema = new Schema(
  {
    companyName: { type: String },
    purchaseOrderNumber: { type: String },
    gstNumber: { type: String },
    billingAddress: { type: String },
    shippingAddress: { type: String },
    contactPerson: { type: String },
    contactPhone: { type: String },
    billingEmail: { type: String },
  },
  { _id: false }
);

/* Department transition history */
const DepartmentHistorySchema = new Schema(
  {
    from: { type: Schema.Types.ObjectId, ref: "Department" },
    to: { type: Schema.Types.ObjectId, ref: "Department" },



    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedAt: { type: Date, default: Date.now },
    notes: { type: String },
  },
  { _id: false }
);


/* ---------- Main Order schema ---------- */
const OrderSchema = new Schema(
  {
    orderNumber: { type: String, required: true, unique: true }, // generate before saving
    user: { type: Schema.Types.ObjectId, refPath: "userModel", required: true }, // who placed order
    userModel: { type: String, required: true, enum: ["User", "Supplier", "Customer"], default: "User" },
    supplier: { type: Schema.Types.ObjectId, ref: "Supplier" }, // primary supplier (optional)
    items: { type: [OrderItemSchema], required: true },

    // shippingAddress: {
    //   fullName: { type: String },
    //   addressLine1: { type: String },
    //   addressLine2: { type: String },
    //   city: { type: String },
    //   state: { type: String },
    //   pincode: { type: String },
    //   phone: { type: String },
    //   email: { type: String },
    // },
    shippingAddress: {
    fullName: String,
    email: String,
    phone: String,
    addressLine1: String,
    addressLine2: String,
    city: String,
    state: String,
    pincode: String,
    country: String,
    lat: Number,
    lng: Number,
  },

    // amounts
    subtotal: { type: Number, required: true, default: 0 },
    gst: { type: Number, default: 0 }, // Stores GST percentage (e.g., 18)
    gstAmount: { type: Number, default: 0 }, // Stores calculated GST amount (e.g., 40.00)
    shippingCharges: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    discounts: { type: Number, default: 0 },
    total: { type: Number, required: true },

    // MOV (Minimum Order Value) fields — for audit/tracking
    movApplied: { type: Boolean, default: false },         // true if order was placed below MOV with delivery charge consent
    movDeliveryCharge: { type: Number, default: 0 },       // ₹250 delivery charge for below-MOV orders (0 if MOV met)

    // Cold Storage Requirements for Logistics
    coldStorageRequirement: {
      isRequired: { type: Boolean, default: false },
      requestedTemperature: { type: String, default: null },
      details: { type: String, default: null }
    },

    currency: { type: String, default: "INR" },

    // lifecycle
    status: { type: String, enum: ORDER_STATUSES, default: "pending" },
    department: { type: Schema.Types.ObjectId, ref: "Department" },
    artApproved: { type: Boolean, default: false },
    artApprovedAt: { type: Date },




    departmentHistory: [DepartmentHistorySchema],
    placedAt: { type: Date, default: Date.now },


    // embedded sub-docs
    invoice: { type: InvoiceSchema },
    payment: { type: PaymentSchema },
    delivery: { type: DeliverySchema },
    b2b: { type: B2BSchema },

    // Driver Location (for real-time tracking via polling)
    driverLocation: {
        lat: Number,
        lng: Number,
        bearing: Number,
        lastUpdated: Date
    },

    // misc
    notes: { type: String },
    cancellationReason: { type: String },
    metadata: { type: Schema.Types.Mixed },

    // Duplicate Order System fields
    isDuplicateOrder: { type: Boolean, default: false },
    duplicateGroupId: { type: Schema.Types.ObjectId },
    duplicateOf: { type: Schema.Types.ObjectId, ref: "Order" },
    duplicateStatus: { 
      type: String, 
      enum: ["none", "pending_review", "merged", "cancelled", "ignored", "separate_valid"], 
      default: "none"
    },
    tallySynced: {
      type: Boolean,
      default: false
    },
    tallyError: {
      type: String,
      default: null
    },
    masterOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
    orderSource: { type: String, enum: ["Customer", "Vendor", "ODT", "Sales", "SCM"], default: "Customer" },
    
    // Links order to an approved price negotiation
    priceNegotiationId: { type: Schema.Types.ObjectId, ref: "PriceNegotiation" }
  },
  {
    timestamps: true,
  }
);

/* Indexes */
// // OrderSchema.index({ orderNumber: 1 }); // Duplicate: unique:true handles this // Already indexed by unique: true
OrderSchema.index({ user: 1 });
OrderSchema.index({ supplier: 1 });
OrderSchema.index({ status: 1 });
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ duplicateGroupId: 1 });
OrderSchema.index({ duplicateStatus: 1 });
OrderSchema.index({ masterOrderId: 1 });

/* ---------- Helpful pre-save hooks (optional) ---------- */

/**
 * Example: if you want to auto-generate orderNumber when saving if missing.
 * You can replace this with your own generator logic.
 */
OrderSchema.pre("validate", function (next) {
  if (!this.orderNumber) {
    // simple generator: ORD-<timestamp>-<shortrandom>
    const short = Math.floor(1000 + Math.random() * 9000);
    this.orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${short}`;
  }

  if (!this.orderSource || this.orderSource === "Customer") {
    if (this.userModel === "Customer") {
      this.orderSource = "Customer";
    } else if (this.userModel === "Supplier") {
      this.orderSource = "Vendor";
    } else if (this.userModel === "User") {
      this.orderSource = "ODT";
    }
  }

  next();
});

/* ---------- Exports ---------- */
if (mongoose.models.Order) {
  delete mongoose.models.Order;
}
const Order = mongoose.models.Order || mongoose.model("Order", OrderSchema);

// --- 🔔 AUTOMATIC NOTIFICATIONS HOOK ---
// This hook ensures that every order status change triggers a notification to the user.
OrderSchema.post("save", async function (doc) {
  try {
    const Notification = mongoose.models.Notification || (await import("./notification")).default;
    
    // Determine if we should notify
    // Note: We use metadata or a custom flag if possible, but status change is reliable
    const statusMap = {
      pending: { title: "Order Placed", message: `Your order ${doc.orderNumber} has been placed successfully.` },
      confirmed: { title: "Order Confirmed", message: `Great news! Your order ${doc.orderNumber} has been confirmed.` },
      packed: { title: "Order Packed", message: `Your order ${doc.orderNumber} is packed and ready for dispatch.` },
      shipped: { title: "Order Shipped", message: `Your order ${doc.orderNumber} is on its way!` },
      out_for_delivery: { title: "Out for Delivery", message: `Your order ${doc.orderNumber} is out for delivery with our partner.` },
      delivered: { title: "Order Delivered", message: `Your order ${doc.orderNumber} has been delivered. Enjoy!` },
      cancelled: { title: "Order Cancelled", message: `Your order ${doc.orderNumber} has been cancelled.` },
      returned: { title: "Return Received", message: `We have received your return for order ${doc.orderNumber}.` },
    };

    const alert = statusMap[doc.status];
    if (alert) {
      // Robust check for existing notification using dot-notation
      const existing = await Notification.findOne({ 
        user: doc.user, 
        "metadata.orderId": doc._id, 
        "metadata.status": doc.status 
      });

      if (!existing) {
        await Notification.create({
          user: doc.user,
          title: alert.title,
          message: alert.message,
          type: doc.status === "cancelled" || doc.status === "failed" ? "error" : "success",
          metadata: { orderId: doc._id, orderNumber: doc.orderNumber, status: doc.status }
        });
        console.log(`[NOTIFY] Status alert sent to User ${doc.user} for order ${doc.orderNumber}`);
      }
    }
  } catch (err) {
    console.error("[NOTIFY ERROR] Failed to send order notification:", err);
  }
});

// Re-export ReturnRequest from its own file for backward compatibility
import ReturnRequest from "./returnRequest";

export default Order;
export { ReturnRequest };
