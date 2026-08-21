import { NextResponse } from 'next/server';
import connectDB from '@/lib/db/connect';
import Customer from '@/lib/db/models/customer';

export async function GET(request) {
  try {
    await connectDB();
    const { searchParams } = new URL(request.url);
    const businessName = searchParams.get('businessName');

    if (!businessName) {
      return NextResponse.json({ error: 'businessName is required' }, { status: 400 });
    }

    const mainOutlets = await Customer.find({ businessName: businessName.trim() }).lean();
    return NextResponse.json(mainOutlets);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
