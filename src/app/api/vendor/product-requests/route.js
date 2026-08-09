import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db/connect';
import ProductRequest from '@/lib/db/models/ProductRequest';
import { getTokenFromReq, verifyToken } from '@/lib/utils/auth';

export async function GET(request) {
  try {
    await dbConnect();
    const token = getTokenFromReq(request);
    let user = null;
    let verifyError = null;
    
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const secret = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET || "fallback_access_token_secret";
        user = jwt.verify(token, secret, { ignoreExpiration: true });
      } catch (err) {
        verifyError = err.message;
      }
    }
    
    if (!user || (!user.id && !user.userId && !user._id)) {
      const debugInfo = { tokenExists: !!token, verifyError, user };
      require('fs').writeFileSync('C:\\Users\\bhosa\\Desktop\\Work\\Unifood_SCM\\HorecaBackend\\debug-401.json', JSON.stringify(debugInfo, null, 2));
      return NextResponse.json({ success: false, message: 'Unauthorized', debug: debugInfo }, { status: 401 });
    }

    const requests = await ProductRequest.find({ supplierId: user.id || user.userId || user._id })
      .sort({ createdAt: -1 });
      
    return NextResponse.json({ success: true, data: requests });
  } catch (error) {
    console.error("Error fetching product requests:", error);
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    await dbConnect();
    const token = getTokenFromReq(request);
    const user = verifyToken(token);
    
    if (!user || (!user.id && !user.userId && !user._id)) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    
    const newRequest = new ProductRequest({
      supplierId: user.id || user.userId || user._id,
      categoryId: body.categoryId,
      categoryName: body.categoryName,
      name: body.name,
      sku: body.sku,
      price: body.price,
      unit: body.unit || 'Kg',
      images: body.imageUrl ? [{ url: body.imageUrl }] : [],
      status: 'Pending'
    });

    await newRequest.save();

    return NextResponse.json({ success: true, data: newRequest }, { status: 201 });
  } catch (error) {
    console.error("Error creating product request:", error.errors || error);
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
