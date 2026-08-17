const fetch = require('node-fetch');

const xml = `<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Export Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <EXPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Stock Item</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
     <STOCKITEMNAME>Dahi</STOCKITEMNAME>
    </STATICVARIABLES>
   </REQUESTDESC>
  </EXPORTDATA>
 </BODY>
</ENVELOPE>`;

fetch('https://yummy-freebee-circular.ngrok-free.dev', {
  method: 'POST',
  body: xml
})
  .then(r => r.text())
  .then(text => {
    const match = text.match(/<CLOSINGBALANCE>([^<]+)<\/CLOSINGBALANCE>/);
    if (match) {
      console.log("SUCCESS! The Closing Balance of Dahi in Tally is:", match[1]);
    } else {
      console.log("Could not find closing balance in Tally response. Response was:");
      console.log(text.substring(0, 500) + "...");
    }
  })
  .catch(console.error);
