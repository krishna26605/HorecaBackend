import mongoose from "mongoose";

const activityLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: ["created", "updated", "deleted", "login", "logout", "generated", "approved", "rejected", "failed", "read"],
    },
    entity: {
      type: String, // e.g., "Employee", "Payslip", "Leave"
      required: true,
    },
    entityId: {
      type: String, // ID of the entity being acted upon
    },
    description: {
      type: String, // Human readable description
      required: true,
    },
    performedBy: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
      name: String,
      email: String,
      role: String,
    },
    details: {
      type: Object, // Flexible field for any extra data (changes, payload, reason)
    },
    status: {
      type: String,
      enum: ["success", "failed"],
      default: "success",
    },
    ipAddress: String,
    userAgent: String,
  },
  {
    timestamps: true, // Adds createdAt (timestamp) and updatedAt
  }
);

// Indexes for searching and filtering
activityLogSchema.index({ action: 1 });
activityLogSchema.index({ entity: 1 });
activityLogSchema.index({ "performedBy.userId": 1 });
activityLogSchema.index({ createdAt: -1 });

delete mongoose.models.ActivityLog;
export default mongoose.model("ActivityLog", activityLogSchema);
