// Identity Verify — checks name, address, phone, and email against consumer
// databases. Returns verification status, corrected addresses, and cross-reference
// matches (does this name match this phone?).
//
// The API key stays secret inside the TEE — agents pay per call via x402 instead
// of needing their own subscription.
//
// At least one parameter is required. Pass as many as you have.
//
/**
 * @param {string?} name - Full name (e.g. "Jane Smith") or object with {first, last}
 * @param {string?} address - Address as a string (e.g. "123 Main St, San Francisco, CA 94105") or object {line1, city, state, zip, country}
 * @param {string?} phone - Phone number, digits only (e.g. "4155551234")
 * @param {string?} email - Email address to verify
 */

const apiKey = params.secrets?.MELISSA_API_KEY;
if (!apiKey) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing MELISSA_API_KEY secret' }),
  });
  throw new Error('Missing MELISSA_API_KEY secret');
}

// At least one input is required
if (!params.name && !params.address && !params.phone && !params.email) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'At least one of name, address, phone, or email is required',
    }),
  });
  throw new Error('No input provided');
}

// Build the Personator API request
const baseUrl = 'https://personator.melissadata.net/v3/WEB/ContactVerify/doContactVerify';
const qp = new URLSearchParams({
  id: apiKey,
  act: 'Check,Verify',
  cols: 'GrpNameDetails,GrpAddressDetails,GrpGeocode,GrpParsedPhone,GrpParsedEmail',
  format: 'json',
});

// Name
if (params.name) {
  if (typeof params.name === 'string') {
    qp.set('full', params.name);
  } else {
    if (params.name.first) qp.set('first', params.name.first);
    if (params.name.last) qp.set('last', params.name.last);
  }
}

// Address — accepts an object {line1, city, state, zip, country} or a free-form string
if (params.address) {
  if (typeof params.address === 'string') {
    // Free-form string: let Melissa parse it
    qp.set('ff', params.address);
  } else {
    if (params.address.line1) qp.set('a1', params.address.line1);
    if (params.address.line2) qp.set('a2', params.address.line2);
    if (params.address.city) qp.set('city', params.address.city);
    if (params.address.state) qp.set('state', params.address.state);
    if (params.address.zip) qp.set('postal', params.address.zip);
    if (params.address.country) qp.set('ctry', params.address.country);
  }
}

// Phone
if (params.phone) {
  qp.set('phone', params.phone);
}

// Email
if (params.email) {
  qp.set('email', params.email);
}

const apiUrl = `${baseUrl}?${qp.toString()}`;
const res = await fetch(apiUrl, {
  headers: { 'Accept': 'application/json' },
});

if (!res.ok) {
  const errText = await res.text();
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: `API failed (${res.status})`,
      body: errText.slice(0, 500),
    }),
  });
  throw new Error(`API failed: ${res.status}`);
}

const data = await res.json();

// Check for service-level errors (in TransmissionResults, not per-record Results)
// Only GE04/GE05/GE06 are fatal (bad/disabled/expired license). Others are warnings.
if (data.TransmissionResults && data.TransmissionResults.trim()) {
  const txResults = data.TransmissionResults.trim();
  var fatalCodes = ['GE04', 'GE05', 'GE06', 'GE14'];
  var isFatal = fatalCodes.some(function(c) { return txResults.indexOf(c) !== -1; });
  if (isFatal) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        error: 'Service error: ' + txResults,
        raw: data,
      }),
    });
    throw new Error('Service error: ' + txResults);
  }
}

const record = data.Records && data.Records[0];
if (!record) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'No results returned',
      transmissionResults: data.TransmissionResults,
    }),
  });
  throw new Error('No records returned');
}

// Parse result codes
const resultCodes = (record.Results || '').split(',').map(function(c) { return c.trim(); }).filter(Boolean);

// Human-readable descriptions for result codes
var CODE_DESCRIPTIONS = {
  // Address Status
  AS01: 'Address fully verified and deliverable',
  AS02: 'Valid building address, but suite/apt missing or invalid',
  AS03: 'Non-USPS address match (may receive UPS/FedEx)',
  AS09: 'Foreign address (non-US/CA)',
  AS10: 'Commercial mail receiving agency (e.g. Mailboxes Etc)',
  AS11: 'PO Box formatted as street address',
  AS12: 'Record moved to new address',
  AS13: 'Address converted from rural to city style',
  AS14: 'Suite appended using company name',
  AS15: 'Apartment appended using last name',
  AS16: 'Vacant address (unoccupied 90+ days)',
  AS17: 'Address does not receive USPS mail delivery',
  AS18: 'DPV locked out — artificially created address detected',
  AS20: 'Deliverable only by USPS (PO Box or military)',
  AS23: 'Extraneous suite information found',
  AS24: 'USPS door not accessible for delivery',
  AS25: 'Unique ZIP code — any address may appear deliverable',
  AS26: 'Unidentified data moved to extras field',
  AS27: 'Phantom route address',
  // Address Errors
  AE01: 'Address could not be verified (missing or invalid locality/ZIP)',
  AE02: 'Unknown street',
  AE03: 'Directional/suffix mismatch — multiple possible matches',
  AE04: 'Physical plot exists but not a deliverable address',
  AE05: 'Multiple address matches — not enough info to choose one',
  AE07: 'Missing minimum address (need at least one line + ZIP or city/state)',
  AE08: 'Suite/apartment number is invalid',
  AE09: 'Suite/apartment number is missing',
  AE10: 'House/building number is invalid',
  AE11: 'House/building number is missing',
  AE12: 'PO/RR/HC box number is invalid',
  AE13: 'PO/RR/HC box number is missing',
  AE14: 'CMRA address — private mailbox number is missing',
  // Address Changes
  AC01: 'ZIP/postal code was changed or added',
  AC02: 'State/province was changed or added',
  AC03: 'City name was changed or added',
  AC05: 'Street alias replaced with preferred full name',
  AC06: 'Address lines were swapped (line 2 was the valid address)',
  AC08: 'ZIP+4 was changed',
  AC10: 'Street name spelling corrected',
  AC11: 'Street type changed (e.g. St to Rd)',
  AC12: 'Directional changed (e.g. N to NW)',
  AC13: 'Suite type changed (e.g. STE to APT)',
  AC14: 'Suite number changed',
  AC20: 'House number changed',
  // Name Status
  NS01: 'Name parsed successfully',
  NS02: 'Error parsing name',
  NS03: 'First name spelling corrected',
  NS05: 'First name found in census data — likely a real name',
  NS06: 'Last name found in census data — likely a real name',
  NS09: 'Dual name parsed into two outputs',
  NS99: 'Company name standardized',
  // Name Errors
  NE01: 'Unrecognized name format',
  NE03: 'Vulgarity detected in name',
  NE04: 'Suspicious/nuisance name detected',
  NE05: 'Company name detected instead of person name',
  // Phone Status
  PS01: 'Phone number verified as valid',
  PS02: 'First 7 digits verified, activity unconfirmed',
  PS03: 'Area code corrected',
  PS06: 'Area code updated due to split',
  PS07: 'Cellular line',
  PS08: 'Landline',
  PS09: 'VoIP line',
  PS10: 'Residential number',
  PS11: 'Business number',
  PS12: 'Small office/home office number',
  PS13: 'Toll-free number',
  PS17: 'Live number — callable and/or can receive SMS',
  PS18: 'Number is on Do Not Call list',
  PS19: 'Disposable phone number (often used to bypass 2FA)',
  PS20: 'Low confidence — number exists in registered block',
  PS21: 'Medium confidence — previously validated',
  PS22: 'High confidence — verified against current equipment',
  // Phone Errors
  PE01: 'Invalid phone number',
  PE02: 'Phone number is blank',
  PE03: 'Too many or too few digits',
  PE04: 'Multiple area code matches — too close to choose',
  PE05: 'Phone prefix not found in database',
  PE11: 'Phone number has been disconnected',
  // Email Status
  ES01: 'Valid email — correct syntax and valid domain',
  ES03: 'Email status unknown — try again later',
  ES04: 'Mobile email address — not deliverable per FCC',
  ES05: 'Disposable email domain',
  ES06: 'Spamtrap domain — mailing could get you blacklisted',
  ES07: 'Accept-all mail server (all emails appear valid)',
  ES08: 'Role/group address (e.g. sales@, support@)',
  ES09: 'Protected mailbox — provider may classify senders as spam',
  ES10: 'Email syntax was corrected',
  ES12: 'Domain spelling was corrected',
  ES20: 'Domain verified but mailbox not confirmed',
  ES21: 'Mailbox found in validated cache',
  ES22: 'Mailbox verified in real-time',
  ES31: 'Suspicious/non-ASCII characters in email',
  ES36: 'Predicted spamtrap mailbox',
  ES37: 'Email exposed in a data breach',
  // Email Errors
  EE01: 'Email syntax error',
  EE02: 'Email domain not found',
  EE03: 'Email mail server not found',
  EE04: 'Invalid mailbox (e.g. noreply)',
  // Geocode Status
  GS01: 'Geocoded to street level',
  GS02: 'Geocoded to neighborhood level',
  GS03: 'Geocoded to community/ZIP centroid',
  GS04: 'Geocoded to state level',
  GS05: 'Geocoded to rooftop level (within property boundaries)',
  GS06: 'Geocoded to interpolated rooftop level',
  GS10: 'Geocoded from phone wire center (low precision)',
  // Geocode Errors (non-fatal, just means geocoding couldn't be done)
  GE01: 'Geocode not found for input locality/ZIP',
  GE02: 'Not enough valid address info to geocode',
  // Verify — cross-reference matches
  VR01: 'Name and address match in records',
  VR02: 'Name and phone match in records',
  VR03: 'Name and email match in records',
  VR04: 'Address and phone match in records',
  VR05: 'Address and email match in records',
  VR06: 'Phone and email match in records',
  VR07: 'Organization and address match in records',
  VR08: 'Organization and phone match in records',
  VR09: 'Organization and email match in records',
  VR10: 'Organization and individual name match in records',
  // Verify Status
  VS00: 'Address not found in reference data',
  VS01: 'Historical/outdated address — newer address exists',
  VS02: 'Partial address match (e.g. street but not suite)',
  VS12: 'Last name only matched',
  VS13: 'First name only matched',
  VS22: 'Partial company name matched',
  VS30: 'Phone not found in reference data',
  VS31: 'Historical/outdated phone — newer number exists',
  VS40: 'Email not found in reference data',
  VS41: 'Historical/outdated email — newer address exists',
  // Append
  DA00: 'Address appended or changed',
  DA01: 'City/state appended from phone wire center',
  DA10: 'Name appended or changed',
  DA20: 'Company name appended or changed',
  DA30: 'Phone number appended or changed',
  DA40: 'Email appended or changed',
  // Demographics
  GD01: 'Male',
  GD02: 'Female',
  GD03: 'Gender could not be determined from name',
};

var descriptions = resultCodes.map(function(code) {
  return { code: code, description: CODE_DESCRIPTIONS[code] || 'Unknown code' };
});

// Melissa returns " " (single space) for empty fields — normalize to null
function clean(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string' && val.trim() === '') return null;
  return val;
}

// Helper to check code prefixes
function hasCode(prefix) {
  return resultCodes.some(function(c) { return c.startsWith(prefix); });
}

// Address verification
const addressDeliverable = resultCodes.indexOf('AS01') !== -1 || resultCodes.indexOf('AS02') !== -1;

// Cross-reference verification codes
const nameAddressMatch = resultCodes.indexOf('VR01') !== -1;
const namePhoneMatch = resultCodes.indexOf('VR02') !== -1;
const nameEmailMatch = resultCodes.indexOf('VR03') !== -1;
const addressPhoneMatch = resultCodes.indexOf('VR04') !== -1;
const addressEmailMatch = resultCodes.indexOf('VR05') !== -1;

// Build clean response — only include sections that have data
const response = {
  resultCodes: descriptions,
  verified: {
    address: addressDeliverable,
    phone: hasCode('PS'),
    email: resultCodes.indexOf('ES01') !== -1,
    name: hasCode('NS'),
  },
  crossReference: {
    nameToAddress: nameAddressMatch,
    nameToPhone: namePhoneMatch,
    nameToEmail: nameEmailMatch,
    addressToPhone: addressPhoneMatch,
    addressToEmail: addressEmailMatch,
  },
};

// Only include sections where we got actual data back
if (clean(record.AddressLine1) || addressDeliverable) {
  response.address = {
    deliverable: addressDeliverable,
    line1: clean(record.AddressLine1),
    line2: clean(record.AddressLine2),
    city: clean(record.City),
    state: clean(record.State),
    zip: clean(record.PostalCode),
    country: clean(record.CountryCode),
    type: clean(record.AddressTypeCode),
    deliveryIndicator: clean(record.DeliveryIndicator),
    latitude: clean(record.Latitude),
    longitude: clean(record.Longitude),
  };
}

if (clean(record.PhoneNumber) || hasCode('PS') || hasCode('PE')) {
  response.phone = {
    verified: hasCode('PS'),
    number: clean(record.PhoneNumber),
    areaCode: clean(record.AreaCode),
    countryCode: clean(record.PhoneCountryCode),
    isCellular: resultCodes.indexOf('PS07') !== -1,
    isLandline: resultCodes.indexOf('PS08') !== -1,
    isVoip: resultCodes.indexOf('PS09') !== -1,
  };
}

if (clean(record.EmailAddress) || resultCodes.indexOf('ES01') !== -1 || hasCode('EE')) {
  response.email = {
    verified: resultCodes.indexOf('ES01') !== -1,
    address: clean(record.EmailAddress),
    domain: clean(record.DomainName),
    isDisposable: resultCodes.indexOf('ES05') !== -1,
    isSpamtrap: resultCodes.indexOf('ES06') !== -1,
    isRoleAddress: resultCodes.indexOf('ES08') !== -1,
  };
}

if (clean(record.NameFull) || clean(record.NameFirst)) {
  response.name = {
    full: clean(record.NameFull),
    first: clean(record.NameFirst),
    last: clean(record.NameLast),
    gender: clean(record.Gender),
  };
}

Lit.Actions.setResponse({
  response: JSON.stringify(response),
});
