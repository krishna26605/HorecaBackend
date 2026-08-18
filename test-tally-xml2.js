const fs = require('fs');
const https = require('https');

const xmlPayload = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="TestProduct123" ACTION="Create">
            <NAME>TestProduct123</NAME>
            <PARENT></PARENT>
            <BASEUNITS>Nos</BASEUNITS>
            <OPENINGBALANCE>0 Nos</OPENINGBALANCE>
            <OPENINGVALUE>0</OPENINGVALUE>
          </STOCKITEM>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

fetch('https://yummy-freebee-circular.ngrok-free.dev', {
  method: 'POST',
  headers: {
    'Content-Type': 'text/xml',
    'ngrok-skip-browser-warning': 'true'
  },
  body: xmlPayload
})
  .then(res => res.text())
  .then(text => console.log('Tally Response:', text))
  .catch(err => console.error('Error:', err));
