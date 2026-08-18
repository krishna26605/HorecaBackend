const fs = require('fs');
const https = require('https');

const xmlPayload = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>List of Accounts</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
          <ACCOUNTTYPE>Stock Groups</ACCOUNTTYPE>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
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
  .then(text => console.log('Tally Response:', text.substring(0, 500)))
  .catch(err => console.error('Error:', err));
