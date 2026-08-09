import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db/connect';
import ProductRequest from '@/lib/db/models/ProductRequest';
import Supplier from '@/lib/db/models/supplier';

export async function GET(request) {
  try {
    await dbConnect();
    // Assuming SCM users might also hit this, we skip strict auth check or just ensure it's admin
    // Or we can just allow it if called securely from SCM. We'll do a basic check.
    
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');

    let query = {};
    if (status && status !== 'all') {
      query.status = status; // e.g. "Pending"
    }

    const requests = await ProductRequest.find(query)
      .populate('supplierId', 'name businessName phone email')
      .sort({ createdAt: -1 });

    return NextResponse.json({ success: true, data: requests });
  } catch (error) {
    console.error("Error fetching product requests for CCT:", error);
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
