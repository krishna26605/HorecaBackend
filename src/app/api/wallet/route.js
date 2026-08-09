import mongoose from "mongoose";
import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import Wallet from "@/lib/db/models/wallet";
import Transaction from "@/lib/db/models/transaction";
import Order from "@/lib/db/models/order";

export async function GET(req) {
  try {
    await dbConnect();
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json({ success: false, error: "userId is required" }, { status: 400 });
    }

    const supplierId = new mongoose.Types.ObjectId(userId);

    // 🛑 [SELF-HEALING 2.0]: DUPLICATE MERGE 
    // If multiple wallets exist for one user, merge them into the first one 
    const allWallets = await Wallet.find({ userId: supplierId }).sort({ createdAt: 1 });
    if (allWallets.length > 1) {
      console.log(`[FIREWALL FIX] Found DUPLICATE Wallets for Vendor ${userId}. Merging...`);
      const mainWallet = allWallets[0];
      for (let i = 1; i < allWallets.length; i++) {
        mainWallet.balance += (allWallets[i].balance || 0);
        mainWallet.realizedSavings += (allWallets[i].realizedSavings || 0);
        mainWallet.escrowedPoints += (allWallets[i].escrowedPoints || 0);
        await Wallet.findByIdAndDelete(allWallets[i]._id);
      }
      await mainWallet.save();
      console.log(`[FIREWALL FIX] Merged ${allWallets.length} wallets into one Master record.`);
    }

    // 1) DYNAMIC BALANCE & CLEANUP (Self-Healing Ledger)
    // We only count settlements for orders that STILL EXIST in the database
    // [FIX]: Search both top-level supplier AND items-level supplier
    const allOrders = await Order.find({
      $or: [
        { supplier: supplierId },
        { "items.supplier": supplierId }
      ]
    }, '_id').lean();
    const validOrderIds = allOrders.map(o => o._id);

    // 🏆 [SELF-HEALING 3.0]: INDESTRUCTIBLE SETTLEMENT (Auto-Release Stuck Points)
    // Scan for orders that are Delivered + Paid but missing a ledger transaction
    const potentialSettlements = await Order.find({
      $or: [{ supplier: supplierId }, { "items.supplier": supplierId }],
      status: "delivered",
      "payment.status": "paid"
    }).lean();

    for (const order of potentialSettlements) {
      // Isolate the specific supplier's portion
      const supplierPortion = (order.items || [])
        .filter(it => it.supplier?.toString() === userId)
        .reduce((sum, it) => sum + (it.totalPrice || 0), 0);

      if (supplierPortion > 0) {
        const settlementTx = await Transaction.findOne({
          userId: supplierId,
          "metadata.orderId": order._id,
          type: "order_settlement"
        });

        if (!settlementTx) {
          console.log(`[FIREWALL RECOVERY] Releasing stuck ₹${supplierPortion} for Order ${order.orderNumber}`);
          const newTx = new Transaction({
            userId: supplierId,
            amount: supplierPortion,
            type: "order_settlement",
            method: "wallet",
            status: "completed",
            description: `Auto-Recovered Settlement: ${order.orderNumber}`,
            metadata: { orderId: order._id, orderNumber: order.orderNumber }
          });
          await newTx.save();
        }
      }
    }

    const ledger = await Transaction.aggregate([
      {
        $match: {
          userId: supplierId,
          status: 'completed',
          // SAFETY: If it's an order settlement, the order must still exist
          $or: [
            { type: { $ne: "order_settlement" } },
            { "metadata.orderId": { $in: validOrderIds } }
          ]
        }
      },
      {
        $group: {
          _id: null,
          totalInflow: {
            $sum: { $cond: [{ $in: ["$type", ["deposit", "refund", "transfer", "order_settlement", "adjustment"]] }, { $abs: "$amount" }, 0] }
          },
          totalOutflow: {
            $sum: { $cond: [{ $in: ["$type", ["withdrawal", "order_payment"]] }, { $abs: "$amount" }, 0] }
          }
        }
      }
    ]);

    const globalSum = ledger[0] || { totalInflow: 0, totalOutflow: 0 };
    const dynamicBalance = Math.max(0, globalSum.totalInflow - globalSum.totalOutflow);

    // Filter transactions list for the UI (only show settlements for existing orders)
    const transactions = await Transaction.find({
      userId: supplierId,
      $or: [
        { type: { $ne: "order_settlement" } },
        { "metadata.orderId": { $in: validOrderIds } }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(10);

    // 2) LIVE METRICS CALCULATION (Marketplace Aware)
    // Realized Savings = Total Business Volume (Delivered)
    // Escrowed Points = Promised Business Volume (Pending/Shipped)
    const orderMetrics = await Order.aggregate([
      {
        $match: {
          $or: [
            { supplier: supplierId },
            { "items.supplier": supplierId }
          ]
        }
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: null,
          deliveredTotal: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$items.supplier", supplierId] },
                    { $eq: ["$status", "delivered"] }
                  ]
                },
                "$items.totalPrice",
                0
              ]
            }
          },
          pendingTotal: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$items.supplier", supplierId] },
                    { $in: ["$status", ["pending", "confirmed", "packed", "shipped", "out_for_delivery"]] }
                  ]
                },
                "$items.totalPrice",
                0
              ]
            }
          }
        }
      }
    ]);
    const metrics = orderMetrics[0] || { deliveredTotal: 0, pendingTotal: 0 };
    console.log(`[WALET LOG] Snapshot Truth: Delivered ₹${metrics.deliveredTotal} | Pending ₹${metrics.pendingTotal}`);

    // 3) SYNC & PERSIST SNAPSHOTS
    let wallet = await Wallet.findOne({ userId: supplierId });
    if (!wallet) {
      console.log(`[WALET LOG] Initializing Wallet for Vendor: ${supplierId}`);
      wallet = new Wallet({
        userId: supplierId,
        balance: dynamicBalance,
        realizedSavings: metrics.deliveredTotal,
        escrowedPoints: metrics.pendingTotal,
        userType: 'supplier'
      });
      await wallet.save();
    } else {
      let isChanged = false;
      if (wallet.balance !== dynamicBalance) {
        console.log(`[WALET LOG] Repairing Balance: ${wallet.balance} -> ${dynamicBalance}`);
        wallet.balance = dynamicBalance;
        isChanged = true;
      }
      if (wallet.realizedSavings !== metrics.deliveredTotal) {
        wallet.realizedSavings = metrics.deliveredTotal;
        isChanged = true;
      }
      if (wallet.escrowedPoints !== metrics.pendingTotal) {
        wallet.escrowedPoints = metrics.pendingTotal;
        isChanged = true;
      }
      if (isChanged) {
        console.log(`[WALET LOG] Persisting Financial Snapshot Refreshed.`);
        await wallet.save();
      }
    }
    // 4) 30-DAY ANALYTICS (Inflow vs Outflow)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const stats30 = await Transaction.aggregate([
      {
        $match: {
          userId: supplierId,
          status: 'completed',
          createdAt: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: null,
          in: { $sum: { $cond: [{ $in: ["$type", ["deposit", "refund", "transfer", "order_settlement", "adjustment"]] }, { $abs: "$amount" }, 0] } },
          out: { $sum: { $cond: [{ $in: ["$type", ["withdrawal", "order_payment"]] }, { $abs: "$amount" }, 0] } }
        }
      }
    ]);

    const flow30 = stats30[0] || { in: 0, out: 0 };

    return NextResponse.json({
      success: true,
      data: {
        balance: wallet.balance,
        currency: wallet.currency || "INR",
        status: wallet.status || "active",
        recentTransactions: transactions,
        metrics: {
          deliveredAmount: wallet.realizedSavings,
          pendingAmount: wallet.escrowedPoints
        },
        stats: {
          inflow: flow30.in,
          outflow: flow30.out,
          netProfit: flow30.in - flow30.out,
          period: "Last 30 Days"
        }
      }
    });
  } catch (err) {
    console.error("GET /api/wallet error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// 🟢 POST /api/wallet: Request a Withdrawal
export async function POST(req) {
  try {
    await dbConnect();
    const body = await req.json();
    const { userId, amount, bankDetails } = body;

    if (!userId || !amount || amount <= 0) {
      return NextResponse.json({ success: false, error: "userId and positive amount are required" }, { status: 400 });
    }

    const supplierId = new mongoose.Types.ObjectId(userId);
    let wallet = await Wallet.findOne({ userId: supplierId });

    if (!wallet || wallet.balance < amount) {
      return NextResponse.json({ success: false, error: "Insufficient balance for withdrawal" }, { status: 400 });
    }

    // 1. Record Withdrawal (Pending)
    const withdrawalTx = new Transaction({
      userId: supplierId,
      walletId: wallet._id,
      amount: amount,
      type: 'withdrawal',
      method: 'bank_transfer',
      status: 'pending',
      description: `Withdrawal request for ₹${amount}`,
      metadata: {
        bankDetails,
        requestedAt: new Date().toISOString()
      }
    });
    await withdrawalTx.save();

    // 2. Lock the funds (Deduct from balance)
    wallet.balance -= amount;
    await wallet.save();

    return NextResponse.json({
      success: true,
      message: "Withdrawal request submitted for processing",
      data: withdrawalTx
    });

  } catch (err) {
    console.error("POST /api/wallet withdrawal error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// 🟠 PATCH /api/wallet: Admin/System manual updates
export async function PATCH(req) {
  // ... rest of previous patch code ...
  try {
    await dbConnect();
    const body = await req.json();
    const { userId, amount, type, status, description } = body;

    if (!userId) {
      return NextResponse.json({ success: false, error: "userId is required" }, { status: 400 });
    }

    const supplierId = new mongoose.Types.ObjectId(userId);
    let wallet = await Wallet.findOne({ userId: supplierId });

    if (!wallet) {
      wallet = new Wallet({ userId: supplierId, balance: 0, userType: 'supplier' });
    }

    // --- CASE 1: Status/Setting Updates ---
    if (status) {
      wallet.status = status;
    }

    // --- CASE 2: Manual Balance Adjustment (with Audit Trail) ---
    if (amount && type) {
      const adjustmentTx = new Transaction({
        userId: supplierId,
        walletId: wallet._id,
        amount: Math.abs(amount),
        type: type, // 'deposit', 'withdrawal', 'adjustment'
        method: 'adjustment',
        status: 'completed',
        description: description || `Admin adjustment: ${type}`,
        metadata: { adminNote: "Manual correction via API" }
      });
      await adjustmentTx.save();

      // Update balance field directly as well for fast access
      if (['deposit', 'transfer', 'adjustment', 'order_settlement'].includes(type)) {
        wallet.balance += Math.abs(amount);
      } else {
        wallet.balance -= Math.abs(amount);
      }
    }

    await wallet.save();

    return NextResponse.json({
      success: true,
      message: "Wallet updated successfully",
      data: wallet
    });

  } catch (err) {
    console.error("PATCH /api/wallet error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
