import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dbConnect from "@/lib/db/connect";
import Customer from "@/lib/db/models/customer";
import { logger } from "@/lib/logger";
import { sendCustomerWelcomeEmail } from "@/lib/mail";

const JWT_SECRET = process.env.JWT_SECRET;

// Helper to geocode address to lat/lng using Nominatim OSM
async function geocodeAddress(addressStr) {
  if (!addressStr || addressStr.trim().length < 5) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addressStr)}&format=json&addressdetails=1&countrycodes=in&limit=1`;
    const res = await fetch(url, { headers: { "User-Agent": "SCM-Logistics-App/1.0" } });
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon)
      };
    }
  } catch (err) {
    console.error("[geocodeAddress] Geocoding fallback error:", err);
  }
  return null;
}

// Helper to escape XML entities
const escapeXML = (str) => {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

// Helper to format Date for Tally (YYYYMMDD)
const formatTallyDate = (dateVal) => {
  if (!dateVal) return "";
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
};

// Helper to build Customer XML for Tally
function buildCustomerXML(customer) {
  const name = escapeXML(customer.name || customer.businessName || customer.phone || "Unknown Customer");
  const mongoId = escapeXML(customer._id.toString());
  const mailingName = escapeXML(customer.businessName || customer.name || customer.phone || "Unknown Customer");

  const address = escapeXML(customer.address || "");
  const city = escapeXML(customer.city || "");
  const state = escapeXML(customer.state || "Maharashtra");
  const pincode = escapeXML(customer.pincode || "");

  const phone = escapeXML(customer.phone || "");
  const email = escapeXML(customer.email || "");
  const gstNumber = escapeXML(customer.gstNumber || "");

  let addressXml = "";
  if (address || city) {
    addressXml = `<ADDRESS.LIST TYPE="String">
              ${address ? `<ADDRESS>${address}</ADDRESS>` : ''}
              ${city ? `<ADDRESS>${city}</ADDRESS>` : ''}
            </ADDRESS.LIST>`;
  }

  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>Unifoods</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${name}" ACTION="Create">
            <NAME>${name}</NAME>
            <LANGUAGENAME.LIST>
              <NAME.LIST TYPE="String">
                <NAME>${name}</NAME>
                <NAME>${mongoId}</NAME>
              </NAME.LIST>
              <LANGUAGECODE> 1033</LANGUAGECODE>
            </LANGUAGENAME.LIST>
            <PARENT>${escapeXML(customer.customerGroup || "Sundry Debtors")}</PARENT>
            <ISBILLWISEON>Yes</ISBILLWISEON>
            <MAILINGNAME>${mailingName}</MAILINGNAME>
            ${addressXml}
            <STATENAME>${state}</STATENAME>
            <COUNTRYNAME>India</COUNTRYNAME>
            ${pincode ? `<PINCODE>${pincode}</PINCODE>` : ''}
            ${phone ? `<MOBILE>${phone}</MOBILE>` : ''}
            ${email ? `<EMAIL>${email}</EMAIL>` : ''}
            <GSTREGISTRATIONTYPE>${gstNumber ? 'Regular' : 'Unregistered'}</GSTREGISTRATIONTYPE>
            ${gstNumber ? `<PARTYGSTIN>${gstNumber}</PARTYGSTIN>` : ''}
            ${customer.gstEffectiveDate ? `<GSTAPPLICABLEDATE>${formatTallyDate(customer.gstEffectiveDate)}</GSTAPPLICABLEDATE>` : ''}
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// Helper to parse Tally responses
function parseTallyResponse(xmlString) {
  if (!xmlString) return { success: false, error: "Empty response from Tally" };

  const createdMatch = xmlString.match(/<CREATED>(\d+)<\/CREATED>/);
  const alteredMatch = xmlString.match(/<ALTERED>(\d+)<\/ALTERED>/);

  const createdCount = createdMatch ? parseInt(createdMatch[1], 10) : 0;
  const alteredCount = alteredMatch ? parseInt(alteredMatch[1], 10) : 0;

  if (createdCount > 0 || alteredCount > 0) {
    return { success: true };
  }

  const errorMatch = xmlString.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/);
  if (errorMatch && errorMatch[1]) {
    return { success: false, error: errorMatch[1].trim() };
  }

  return { success: false, error: "Failed to parse Tally response", raw: xmlString };
}


export async function POST(req) {
  try {
    const body = await req.json();
    const {
      password, email, phone, businessName, gstNumber, panNumber,
      licenseImage, name, locations, hasMultipleOutlets, outlets, supplierId, category, customerType, department, poMandatory,
      creditTerm, creditLimit, urcDocUrl, assignedRoute, routeName, routeCode,
      lat, lng, isContractBased, contract, contractType, contractDocumentUrl, contractStartDate, contractExpiryDate, contractNotes
    } = body;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return NextResponse.json({ success: false, error: "Invalid email address" }, { status: 400 });
    }

    const username = email.toLowerCase().trim();

    if (!category || !['A', 'B', 'C'].includes(category)) {
      return NextResponse.json({ success: false, error: "Valid customer tier (A, B, C) is required" }, { status: 400 });
    }

    const generateSystemPassword = () => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
      let randomStr = "";
      for (let i = 0; i < 6; i++) {
        randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return `Unifoods@${randomStr}`;
    };

    let finalPassword = password ? password.trim() : "";
    let isSystemGenerated = false;

    if (!finalPassword) {
      finalPassword = generateSystemPassword();
      isSystemGenerated = true;
      console.log(`[Auto Password] System generated password for ${username}: ${finalPassword}`);
    } else if (finalPassword.length < 8) {
      return NextResponse.json({ success: false, error: "Password must be at least 8 characters if entered manually" }, { status: 400 });
    }


    if (!phone || phone.replace(/\D/g, "").length < 10) {
      return NextResponse.json({ success: false, error: "Invalid phone number" }, { status: 400 });
    }

    if (!name || name.trim().length < 2) {
      return NextResponse.json({ success: false, error: "Full name is required" }, { status: 400 });
    }

    if (!businessName || businessName.trim().length < 2) {
      return NextResponse.json({ success: false, error: "Business name is required" }, { status: 400 });
    }

    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const isUrg = gstNumber === "URG" || gstNumber === "Unregistered" || body.isUrg === true;
    if (!isUrg && (!gstNumber || !gstRegex.test(gstNumber.trim().toUpperCase()))) {
      return NextResponse.json({ success: false, error: "Either a valid GST number or URG (Unregistered) selection is required" }, { status: 400 });
    }

    if (!locations || !Array.isArray(locations) || locations.length === 0) {
      return NextResponse.json({ success: false, error: "At least one business location is required" }, { status: 400 });
    }

    // Validate the first location at least
    const primaryLocation = locations[0];
    if (!primaryLocation.address || primaryLocation.address.trim().length < 5) {
      return NextResponse.json({ success: false, error: "Valid business address is required" }, { status: 400 });
    }
    if (!primaryLocation.city || primaryLocation.city.trim().length < 2) {
      return NextResponse.json({ success: false, error: "City is required" }, { status: 400 });
    }
    if (!primaryLocation.state || primaryLocation.state.trim().length < 2) {
      return NextResponse.json({ success: false, error: "State is required" }, { status: 400 });
    }
    const pinRegex = /^[1-9][0-9]{5}$/;
    if (!primaryLocation.pincode || !pinRegex.test(primaryLocation.pincode)) {
      return NextResponse.json({ success: false, error: "Valid 6-digit PIN code is required" }, { status: 400 });
    }

    // Ensure all locations are valid and structured
    const formattedLocations = [];
    for (let index = 0; index < locations.length; index++) {
      const loc = locations[index];
      let itemLat = loc.lat != null ? loc.lat : (index === 0 && lat != null ? lat : null);
      let itemLng = loc.lng != null ? loc.lng : (index === 0 && lng != null ? lng : null);

      if (itemLat == null || itemLng == null) {
        const fullAddr = `${loc.address || ""}, ${loc.city || ""}, ${loc.state || ""}, ${loc.pincode || ""}`;
        const coords = await geocodeAddress(fullAddr);
        if (coords) {
          itemLat = coords.lat;
          itemLng = coords.lng;
        }
      }

      formattedLocations.push({
        outletName: loc.outletName?.trim() || (index === 0 ? "Main Branch" : null),
        address: loc.address?.trim() || "",
        city: loc.city?.trim() || "",
        state: loc.state?.trim() || "",
        pincode: loc.pincode?.trim() || "",
        contactPerson: loc.contactPerson?.trim() || null,
        contactPhone: loc.contactPhone?.trim() || null,
        contactEmail: loc.contactEmail?.trim() || null,
        assignedRoute: loc.assignedRoute || null,
        routeName: loc.routeName || null,
        routeCode: loc.routeCode || null,
        lat: itemLat,
        lng: itemLng,
        isPrimary: index === 0
      });
    }

    const finalLat = lat != null ? lat : (formattedLocations[0]?.lat != null ? formattedLocations[0].lat : null);
    const finalLng = lng != null ? lng : (formattedLocations[0]?.lng != null ? formattedLocations[0].lng : null);


    await dbConnect();

    // Check if user already exists
    const existingUser = await Customer.findOne({
      $or: [{ username }, { email }, { phone }]
    });

    if (existingUser) {
      let conflictField = "User";
      if (existingUser.username === username) conflictField = "Username";
      else if (existingUser.email === email) conflictField = "Email";
      else if (existingUser.phone === phone) conflictField = "Phone number";

      return NextResponse.json({ success: false, error: `${conflictField} already exists` }, { status: 409 });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(finalPassword, salt);

    // Normalize Phone
    const numericPhone = phone.replace(/\D/g, "");
    const standardizedPhone = (numericPhone.length === 10) ? `+91${numericPhone}` :
      (numericPhone.length === 12 && numericPhone.startsWith("91")) ? `+${numericPhone}` :
        phone.trim();

    // Create user
    const newUser = await Customer.create({
      isVerified: !!(body.preApproved || body.isVerified),
      username,
      password: hashedPassword,
      email: email.toLowerCase(),
      phone: standardizedPhone,
      name: name.trim(),
      address: primaryLocation.address.trim(),
      city: primaryLocation.city || null,
      state: primaryLocation.state || null,
      pincode: primaryLocation.pincode || null,
      lat: finalLat,
      lng: finalLng,
      location: finalLat != null && finalLng != null ? { type: "Point", coordinates: [finalLng, finalLat] } : undefined,
      locations: formattedLocations,
      hasMultipleOutlets: Boolean(hasMultipleOutlets),
      source: body.source || "Self-Registered",
      departmentContacts: {
        art: {
          name: body.departmentContacts?.art?.name?.trim() || null,
          phone: body.departmentContacts?.art?.phone?.trim() || null,
          email: body.departmentContacts?.art?.email?.trim() || null
        },
        act: {
          name: body.departmentContacts?.act?.name?.trim() || null,
          phone: body.departmentContacts?.act?.phone?.trim() || null,
          email: body.departmentContacts?.act?.email?.trim() || null
        },
        odt: {
          name: body.departmentContacts?.odt?.name?.trim() || null,
          phone: body.departmentContacts?.odt?.phone?.trim() || null,
          email: body.departmentContacts?.odt?.email?.trim() || null
        },
        scm: {
          name: body.departmentContacts?.scm?.name?.trim() || null,
          phone: body.departmentContacts?.scm?.phone?.trim() || null,
          email: body.departmentContacts?.scm?.email?.trim() || null
        },
        routePlanner: {
          name: body.departmentContacts?.routePlanner?.name?.trim() || null,
          phone: body.departmentContacts?.routePlanner?.phone?.trim() || null,
          email: body.departmentContacts?.routePlanner?.email?.trim() || null
        }
      },
      outlets: formattedLocations.filter(loc => !loc.isPrimary).map(loc => ({
        outletName: loc.outletName,
        address: loc.address,
        city: loc.city,
        state: loc.state,
        pincode: loc.pincode,
        contactPerson: loc.contactPerson,
        contactPhone: loc.contactPhone,
        contactEmail: loc.contactEmail,
        assignedRoute: loc.assignedRoute,
        routeName: loc.routeName,
        routeCode: loc.routeCode,
        lat: loc.lat,
        lng: loc.lng
      })),
      businessName: businessName.trim(),
      gstNumber: gstNumber || null,
      gstEffectiveDate: body.gstEffectiveDate || null,
      gstDocUrl: body.gstDocUrl || null,
      panNumber: panNumber ? panNumber.trim().toUpperCase() : null,
      assignedRoute: assignedRoute || null,
      routeName: routeName || null,
      routeCode: routeCode || null,
      licenseImage,
      category,
      customerGroup: body.customerGroup || body.tallyGroup || "Sundry Debtors",
      advanceBalance: Number(body.advanceAmount || 0),
      hasPaidAdvance: body.hasPaidAdvance !== undefined ? Boolean(body.hasPaidAdvance) : false,
      advancePaymentMode: body.advancePaymentMode || null,
      advancePaymentProofUrl: body.advancePaymentProofUrl || null,
      customerType: customerType || null,
      department: department || null,
      poMandatory: poMandatory || false,
      creditTerm: Number(creditTerm || 0),
      creditLimit: Number(creditLimit || 0),
      urcDocUrl: urcDocUrl || null,
      hasFssai: body.hasFssai !== undefined ? Boolean(body.hasFssai) : true,
      fssaiNumber: body.fssaiNumber ? body.fssaiNumber.trim() : null,
      fssaiExpiryDate: body.fssaiExpiryDate ? new Date(body.fssaiExpiryDate) : null,
      fssaiDocUrl: body.fssaiDocUrl || null,
      fssaiUndertakingDocUrl: body.fssaiUndertakingDocUrl || null,
      licenseExpiryDate: body.licenseExpiryDate ? new Date(body.licenseExpiryDate) : null,
      supplierId: supplierId || null,
      isContractBased: Boolean(isContractBased),
      contract: isContractBased ? {
        contractType: contract?.contractType || contractType || null,
        documentUrl: contract?.documentUrl || contractDocumentUrl || null,
        startDate: contract?.startDate || contractStartDate ? new Date(contract?.startDate || contractStartDate) : null,
        expiryDate: contract?.expiryDate || contractExpiryDate ? new Date(contract?.expiryDate || contractExpiryDate) : null,
        notes: contract?.notes || contractNotes || null,
        uploadedAt: new Date()
      } : undefined,
      lastLoginAt: new Date()
    });

    await logger({
      level: 'info',
      message: `New customer registered: ${newUser.username}`,
      action: 'CUSTOMER_REGISTERED',
      userId: newUser._id,
      userModel: 'Customer',
      metadata: { username, email },
      req
    });

    // 📧 Send Automated Welcome Email to Customer if Pre-Approved (SCM onboarding)
    let mailResult = null;
    if (newUser.isVerified) {
      try {
        if (email) {
          const isUrgCustomer = body.isUrg || gstNumber === "URG" || gstNumber === "Unregistered" || !gstNumber;
          console.log(`[Email Dispatcher] Attempting welcome email for ${email} (URG: ${isUrgCustomer})`);

          mailResult = await sendCustomerWelcomeEmail({
            email: email.trim(),
            name: name ? name.trim() : businessName.trim(),
            businessName: businessName.trim(),
            username: username.trim(),
            password: finalPassword,
            gstNumber: isUrgCustomer ? "URG" : (gstNumber ? gstNumber.trim().toUpperCase() : "URG"),
            creditTerm: Number(creditTerm || 0),
            creditLimit: Number(creditLimit || 0),
            customerId: newUser._id.toString()
          });

          console.log(`[Email Notification Result] Success: ${mailResult?.success} | MessageId: ${mailResult?.messageId} | Error: ${mailResult?.error}`);

          await logger({
            level: mailResult?.success ? 'info' : 'error',
            message: mailResult?.success ? `Welcome email sent to ${email}` : `Failed to send welcome email to ${email}: ${mailResult?.error}`,
            action: 'CUSTOMER_WELCOME_EMAIL',
            userId: newUser._id,
            userModel: 'Customer',
            metadata: { email, mailResult },
            req
          });
        }
      } catch (mailErr) {
        console.error("[Email Notification Error] Failed to send welcome email:", mailErr);
        mailResult = { success: false, error: mailErr.message || String(mailErr) };
      }
    } else {
      console.log(`[Email Dispatcher] Welcome email skipped for ${email} (Awaiting CCT approval)`);
    }

    // Create JWT
    const token = jwt.sign(
      { _id: newUser._id, phone: newUser.phone, category: newUser.category, username: newUser.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Sync Customer Ledger to Tally Prime 9
    const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
    let tallyCustomerSynced = false;
    let tallyCustomerError = null;

    try {
      const xmlPayload = buildCustomerXML(newUser);
      console.log(`[Tally Sync Register] Sending POST to Tally at URL: ${tallyUrl}`);
      console.log(`[Tally Sync Register] Generated XML Payload:\n${xmlPayload}`);

      const tallyResponse = await fetch(tallyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml',
          'ngrok-skip-browser-warning': 'true'
        },
        body: xmlPayload
      });

      console.log(`[Tally Sync Register] Received response from Tally. Status: ${tallyResponse.status} ${tallyResponse.statusText}`);

      if (tallyResponse.ok) {
        const responseText = await tallyResponse.text();
        console.log(`[Tally Sync Register] Raw Tally Response Text:\n${responseText}`);

        const parsed = parseTallyResponse(responseText);
        console.log(`[Tally Sync Register] Parsed Response Success:`, parsed.success);

        if (parsed.success) {
          tallyCustomerSynced = true;
          console.log(`[Tally Sync] Customer synced successfully to Tally.`);

          // Fetch the generated GUID from Tally and store it
          try {
            const guidPayload = `<ENVELOPE>
              <HEADER>
                <VERSION>1</VERSION>
                <TALLYREQUEST>EXPORT</TALLYREQUEST>
                <TYPE>COLLECTION</TYPE>
                <ID>LedgerCollection</ID>
              </HEADER>
              <BODY>
                <DESC>
                  <STATICVARIABLES>
                    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                    <SVCURRENTCOMPANY>${escapeXML(process.env.TALLY_SALES_COMPANY || 'Unifoods')}</SVCURRENTCOMPANY>
                  </STATICVARIABLES>
                  <TDL>
                    <TDLMESSAGE>
                      <COLLECTION NAME="LedgerCollection">
                        <TYPE>Ledger</TYPE>
                        <FETCH>GUID</FETCH>
                        <FILTER>NameFilter</FILTER>
                      </COLLECTION>
                      <SYSTEM TYPE="Formulae" NAME="NameFilter">
                        $_Id = "${escapeXML(newUser._id.toString())}"
                      </SYSTEM>
                    </TDLMESSAGE>
                  </TDL>
                </DESC>
              </BODY>
            </ENVELOPE>`;

            const guidResponse = await fetch(tallyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'text/xml' },
              body: guidPayload
            });

            if (guidResponse.ok) {
              const guidXml = await guidResponse.text();
              const guidMatch = guidXml.match(/<GUID>([^<]+)<\/GUID>/);
              if (guidMatch && guidMatch[1]) {
                newUser.tallyId = guidMatch[1];
                await newUser.save();
                console.log(`[Tally Sync] Fetched and stored Tally GUID: ${newUser.tallyId}`);
              }
            }
          } catch (guidErr) {
            console.error(`[Tally Sync] Failed to fetch GUID for customer:`, guidErr);
          }
        } else {
          tallyCustomerError = parsed.error;
          console.error(`[Tally Sync] Tally error syncing customer:`, parsed.error);
        }
      } else {
        tallyCustomerError = `Tally server responded with status ${tallyResponse.status}`;
        console.error(`[Tally Sync] Tally server responded with status ${tallyResponse.status}`);
      }
    } catch (err) {
      tallyCustomerError = err.message || String(err);
      console.error(`[Tally Sync] Exception syncing customer:`, err);
    }

    return NextResponse.json({
      success: true,
      data: {
        accessToken: token,
        tallyCustomerSynced,
        tallyCustomerError,
        emailSent: mailResult?.success || false,
        emailError: mailResult?.error || null,
        emailMessageId: mailResult?.messageId || null,
        user: {
          id: newUser._id,
          username: newUser.username,
          phone: newUser.phone,
          email: newUser.email,
          name: newUser.name,
          businessName: newUser.businessName,
          category: newUser.category
        },
      },
    });
  } catch (err) {
    console.error("🔥 CUSTOMER REGISTRATION ERROR:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}