import mongoose from "mongoose";

const CustomerSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    name: {
      type: String,
      default: null,
      trim: true
    },

    username: {
      type: String,
      sparse: true,
      unique: true,
      trim: true
    },

    password: {
      type: String,
      trim: true
    },

    businessName: {
      type: String,
      trim: true,
      default: null
    },

    gstNumber: {
      type: String,
      trim: true,
      default: null
    },

    gstEffectiveDate: {
      type: Date,
      default: null
    },

    gstDocUrl: {
      type: String,
      default: null,
      trim: true
    },

    panNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: null
    },

    licenseImage: {
      type: String,
      trim: true,
      default: null
    },

    email: {
      type: String,
      sparse: true,
      unique: true,
      trim: true,
      lowercase: true
    },

    address: {
      type: String,
      default: null,
      trim: true
    },

    city: { type: String, default: null },
    state: { type: String, default: null },
    pincode: { type: String, default: null },

    assignedRoute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RouteMaster",
      default: null
    },
    routeName: { type: String, default: null, trim: true },
    routeCode: { type: String, default: null, trim: true },

    hasMultipleOutlets: {
      type: Boolean,
      default: false
    },

    // Outlet Hierarchy
    isSubOutlet: {
      type: Boolean,
      default: false
    },
    parentCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null
    },
    outletName: {
      type: String,
      trim: true,
      default: null
    },

    source: {
      type: String,
      default: "Self-Registered",
      trim: true
    },

    departmentContacts: {
      art: {
        name: { type: String, trim: true, default: null },
        phone: { type: String, trim: true, default: null },
        email: { type: String, trim: true, default: null }
      },
      act: {
        name: { type: String, trim: true, default: null },
        phone: { type: String, trim: true, default: null },
        email: { type: String, trim: true, default: null }
      },
      odt: {
        name: { type: String, trim: true, default: null },
        phone: { type: String, trim: true, default: null },
        email: { type: String, trim: true, default: null }
      },
      scm: {
        name: { type: String, trim: true, default: null },
        phone: { type: String, trim: true, default: null },
        email: { type: String, trim: true, default: null }
      },
      routePlanner: {
        name: { type: String, trim: true, default: null },
        phone: { type: String, trim: true, default: null },
        email: { type: String, trim: true, default: null }
      }
    },

    outlets: [{
      outletName: { type: String, trim: true },
      address: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
      contactPerson: { type: String, trim: true, default: null },
      contactPhone: { type: String, trim: true, default: null },
      contactEmail: { type: String, trim: true, default: null },
      assignedRoute: { type: mongoose.Schema.Types.ObjectId, ref: "RouteMaster", default: null },
      routeName: { type: String, trim: true, default: null },
      routeCode: { type: String, trim: true, default: null },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      hasFssai: { type: Boolean, default: true },
      fssaiNumber: { type: String, default: null, trim: true },
      fssaiExpiryDate: { type: Date, default: null },
      fssaiDocUrl: { type: String, default: null, trim: true },
      fssaiUndertakingDocUrl: { type: String, default: null, trim: true },
      password: { type: String, default: null, trim: true }
    }],

    locations: [{
      outletName: { type: String, trim: true, default: null },
      address: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
      contactPerson: { type: String, trim: true, default: null },
      contactPhone: { type: String, trim: true, default: null },
      contactEmail: { type: String, trim: true, default: null },
      assignedRoute: { type: mongoose.Schema.Types.ObjectId, ref: "RouteMaster", default: null },
      routeName: { type: String, trim: true, default: null },
      routeCode: { type: String, trim: true, default: null },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      isPrimary: { type: Boolean, default: false },
      hasFssai: { type: Boolean, default: true },
      fssaiNumber: { type: String, default: null, trim: true },
      fssaiExpiryDate: { type: Date, default: null },
      fssaiDocUrl: { type: String, default: null, trim: true },
      fssaiUndertakingDocUrl: { type: String, default: null, trim: true },
      password: { type: String, default: null, trim: true }
    }],

    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null
    },
    tallyId: {
      type: String,
      default: null
    },
    customerGroup: {
      type: String,
      default: "Sundry Debtors",
      trim: true
    },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },

    // GeoJSON point for spatial queries
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: [0, 0] }
    },

    isVerified: {
      type: Boolean,
      default: false
    },

    category: {
      type: String,
      enum: ["A", "B", "C"],
      required: true,
      default: "C"
    },

    poMandatory: {
      type: Boolean,
      default: false
    },

    customerType: {
      type: String,
      default: null,
      trim: true
    },

    department: {
      type: String,
      default: null,
      trim: true
    },

    advanceBalance: {
      type: Number,
      default: 0
    },

    hasPaidAdvance: {
      type: Boolean,
      default: false
    },

    advancePaymentMode: {
      type: String,
      default: null,
      trim: true
    },

    advancePaymentProofUrl: {
      type: String,
      default: null,
      trim: true
    },

    creditTerm: {
      type: Number,
      enum: [0, 7, 15, 30, 45, 60],
      default: 0
    },

    creditLimit: {
      type: Number,
      default: 0,
      min: 0
    },

    cnBalance: {
      type: Number,
      default: 0
    },

    isContractBased: {
      type: Boolean,
      default: false
    },

    urdDocUrl: {
      type: String,
      default: null,
      trim: true
    },

    hasFssai: {
      type: Boolean,
      default: true
    },

    fssaiNumber: {
      type: String,
      default: null,
      trim: true
    },

    fssaiExpiryDate: {
      type: Date,
      default: null
    },

    fssaiDocUrl: {
      type: String,
      default: null,
      trim: true
    },

    fssaiUndertakingDocUrl: {
      type: String,
      default: null,
      trim: true
    },

    licenseExpiryDate: {
      type: Date,
      default: null
    },

    contract: {
      contractType: { type: String, default: null, trim: true },
      documentUrl: { type: String, default: null, trim: true },
      startDate: { type: Date, default: null },
      expiryDate: { type: Date, default: null },
      notes: { type: String, default: null, trim: true },
      uploadedAt: { type: Date, default: null }
    },

    contracts: [{
      brandId: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", default: null },
      brandName: { type: String, default: null, trim: true },
      contractType: { type: String, default: null, trim: true },
      documentUrl: { type: String, default: null, trim: true },
      startDate: { type: Date, default: null },
      expiryDate: { type: Date, default: null },
      notes: { type: String, default: null, trim: true },
      uploadedAt: { type: Date, default: null }
    }],

    lastLoginAt: {
      type: Date,
      default: null
    },

    // Portal-visible display override name for sub-outlets
    displayName: {
      type: String,
      trim: true,
      default: null
    }
  },
  {
    timestamps: true,
    collection: "customers"
  }
);

CustomerSchema.index({ location: "2dsphere" });

export default mongoose.models.Customer ||
  mongoose.model("Customer", CustomerSchema);
