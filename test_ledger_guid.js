const https = require('https');

const tallyUrl = 'https://yummy-freebee-circular.ngrok-free.dev/';
const ledgerName = 'CUST001';

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
            <FETCH>NAME,GUID,MASTERID,ALTERID</FETCH>
            <FILTER>NameFilter</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="NameFilter">
            $Name = "${ledgerName}" OR $_Id = "${ledgerName}"
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

const req = https.request(tallyUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'text/xml',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let xmlText = '';
  res.on('data', d => xmlText += d);
  res.on('end', () => console.log(xmlText));
});

req.on('error', console.error);
req.write(payload);
req.end();
