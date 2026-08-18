const http = require('http');

const payload = `<ENVELOPE>
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
        <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="LedgerCollection">
            <TYPE>Ledger</TYPE>
            <FETCH>NAME,PARENT</FETCH>
            <FILTER>CreditorFilter</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="CreditorFilter">
            $IsBelongTo:Group:"Sundry Creditors"
          </SYSTEM>
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
    console.log("Creditor filter response length:", xmlText.length);
    console.log(xmlText.substring(0, 800));
  });
});

req.on('error', (err) => console.error(err.message));
req.write(payload);
req.end();
