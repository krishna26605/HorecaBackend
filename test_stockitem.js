const http = require('http');

const payload = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>StockItemCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="StockItemCollection">
            <TYPE>Stock Item</TYPE>
            <FETCH>NAME,BASEUNITS,PARENT,CLOSINGBALANCE,STANDARDCOST,STANDARDPRICE</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

const req = http.request('http://localhost:9000', {
  method: 'POST',
  headers: {
    'Content-Type': 'text/xml',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let xmlText = '';
  res.on('data', d => xmlText += d);
  res.on('end', () => {
    const match = xmlText.match(/<STOCKITEM NAME[^>]*>[\s\S]*?<\/STOCKITEM>/);
    if (match) {
      console.log(match[0]);
    } else {
      console.log("No STOCKITEM found in response. length:", xmlText.length);
    }
  });
});

req.on('error', (err) => console.error(err.message));
req.write(payload);
req.end();
