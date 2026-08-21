import { NextResponse } from 'next/server';
import connectDB from '@/lib/db/connect';
import Customer from '@/lib/db/models/customer';

export async function GET(request, { params }) {
  try {
    await connectDB();
    const { id } = params;

    if (!id) {
      return NextResponse.json({ error: 'Outlet ID is required' }, { status: 400 });
    }

    const customer = await Customer.findById(id).lean();
    if (!customer) {
      return NextResponse.json({ error: 'Main outlet not found' }, { status: 404 });
    }

    const subOutlets = Array.isArray(customer.locations) ? customer.locations : [];
    
    return NextResponse.json(subOutlets.filter(l => l.address));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
