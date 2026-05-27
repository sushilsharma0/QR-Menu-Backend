const mongoose = require("mongoose");

const packageHistorySchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
    },
    assignmentKind: {
      type: String,
      enum: ["catalog", "custom"],
      default: "catalog",
    },
    package: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      required: function packageRequired() {
        return this.assignmentKind !== "custom";
      },
    },
    customSnapshot: {
      planLabel: String,
      durationDays: Number,
      limits: mongoose.Schema.Types.Mixed,
      featureFlags: mongoose.Schema.Types.Mixed,
    },
    action: {
      type: String,
      enum: [
        "assigned",
        "renewed",
        "upgraded",
        "downgraded",
        "cancelled",
        "expired",
      ],
      required: true,
    },
    previousPackage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    amount: { type: Number, required: true },
    paymentMethod: { type: String, enum: ["online", "offline", "free"] },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Platform" },
    notes: String,
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "SubscriptionInvoice" },
  },
  { timestamps: true },
);

packageHistorySchema.index({ restaurant: 1, createdAt: -1 });
packageHistorySchema.index({ package: 1 });

module.exports = mongoose.model("PackageHistory", packageHistorySchema);
