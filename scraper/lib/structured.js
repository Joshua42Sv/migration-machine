// Shapes one captured case's raw endpoint responses into the importer-ready
// record (CaseImportDto fields + billing templates + costs). Extracted from
// runAll.js so the transformation runs per case at export time and the result
// is stored alongside the raw data in data/<caseId>.json.

function buildLookupMap(lookups) {
  const map = {};
  for (const list of Object.values(lookups)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item.ID && item.Description) map[item.ID] = item.Description;
    }
  }
  return map;
}

function buildEmployeeMap(employeeList) {
  const map = {};
  for (const employee of employeeList) {
    if (!employee.ID) continue;
    map[employee.ID] = {
      firstName: employee.FirstName ?? '',
      lastName: employee.LastName ?? '',
      email: employee.UserID ?? '',
      phone: employee.Phone1 ?? '',
      qualifications: employee.ServicesDescription ?? '',
    };
  }
  return map;
}

function nullId(id) {
  return !id || id === '00000000-0000-0000-0000-000000000000';
}

function resolveId(map, id) {
  if (nullId(id)) return '';
  return map[id] ?? '';
}

function formatDate(iso) {
  if (!iso) return '';
  return iso.split('T')[0];
}

function buildAddress(map, { street, suburb, postalCode, regionId, countryId }) {
  return {
    addressLine1: street ?? '',
    addressLine2: '',
    suburb: suburb ?? '',
    state: resolveId(map, regionId),
    postcode: postalCode ?? '',
    country: resolveId(map, countryId),
  };
}

// Each estimate in the source system becomes one billing template, its cost
// rows the template's items. A /CaseEstimate/GetData response is a flat tree:
// the row carrying an Estimate payload is the estimate itself (ItemType is
// not reliable - grouping rows reuse 0), rows with a Cost payload are the
// billable line items, possibly nested under grouping rows. NotusPoint money
// is GST-INCLUSIVE cents (invoicing extracts GST from totals), so rates come
// from UnitChargeAmt as-is; hourly quantities (CostType 0) are decimal hours
// in Case Manager and seconds in the NotusPoint importer.
function buildBillingTemplates(caseId, endpoints) {
  const estimateList = endpoints?.['/CaseEstimate/_List']?.[0] ?? [];
  const itemsByEstimateId = {};

  for (const response of endpoints?.['/CaseEstimate/GetData'] ?? []) {
    const rows = Array.isArray(response?.Items) ? response.Items : [];
    const rowById = new Map(rows.map(row => [row.ID, row]));
    const ownerEstimateId = (row) => {
      let node = row;
      while (node && !node.Estimate) node = rowById.get(node.ParentID);
      return node?.ID ?? '';
    };

    for (const row of rows) {
      if (!row.Cost) continue;
      const estimateId = ownerEstimateId(row);
      (itemsByEstimateId[estimateId] ??= []).push(row.Cost);
    }
  }

  return estimateList.map(estimate => {
    const createdAt = formatDate(estimate.DateCreated);
    const expiryDate = formatDate(estimate.FinishDate);

    const items = (itemsByEstimateId[estimate.ID] ?? []).map(cost => {
      const hourly = cost.CostType === 0;
      const item = {
        id: cost.ID,
        name: cost.Description || 'Unknown',
        chargeCode: cost.ChargeCode ?? '',
        billingType: hourly ? 'HOURLY' : 'FIXED_AMOUNT',
        taxType: cost.UnitChargeTaxCode === 'GST' || cost.UnitChargeTaxRate > 0 ? 'GST' : 'GST_FREE',
        rate: Math.round((cost.UnitChargeAmt ?? 0) * 100),
        quantity: hourly ? Math.round((cost.Quantity ?? 0) * 3600) : Math.round(cost.Quantity ?? 0),
        // CM's stored line total; saved verbatim so NotusPoint matches to
        // the cent instead of re-deriving from the rounded rate/quantity
        total: Math.round((cost.TotalCharge ?? 0) * 100),
        billingTemplateInstanceId: estimate.ID,
        createdAt: formatDate(cost.StartDate) || createdAt,
      };
      const itemExpiry = formatDate(cost.FinishDate) || expiryDate;
      if (itemExpiry) item.expiryDate = itemExpiry;
      return item;
    });

    const template = {
      id: estimate.ID,
      name: estimate.Description ?? '',
      items,
      caseId,
      createdAt,
      archived: estimate.IsCurrent !== true,
    };
    if (expiryDate) template.expiryDate = expiryDate;
    return template;
  });
}

// Logged costs from /CaseCost/GetData. EstimateCostID links a cost to the
// estimate cost row it was logged against (= billing template item id);
// costs without one are kept but need special handling at upload time.
// UnitChargeAmt/TotalCharge include GST, which matches NotusPoint's
// convention (invoicing extracts GST from the total), so dollars -> cents
// as-is. Hourly quantities are converted from Case Manager decimal hours to
// NotusPoint seconds. employeeId is the Case Manager ID; the uploader resolves
// it to a NotusPoint user created by the staff import.
function buildCosts(endpoints) {
  return (endpoints?.['/CaseCost/GetData'] ?? []).map(cost => {
    const hourly = cost.CostType === 0;
    return {
      status: cost.IsInvoiced ? 'INVOICED' : 'LOGGED',
      quantity: hourly ? Math.round((cost.Quantity ?? 0) * 3600) : Math.round(cost.Quantity ?? 0),
      rate: Math.round((cost.UnitChargeAmt ?? 0) * 100),
      total: Math.round((cost.TotalCharge ?? 0) * 100),
      billingInstanceItemId: nullId(cost.EstimateCostID) ? '' : cost.EstimateCostID,
      // Case Manager document created alongside the cost (e.g. the file note);
      // the uploader resolves it to the NotusPoint file the document import created
      documentId: nullId(cost.DocumentID) ? '' : cost.DocumentID,
      employeeId: nullId(cost.EmployeeID) ? '' : cost.EmployeeID,
      date: formatDate(cost.ReferenceDate),
      createdAt: formatDate(cost.ReferenceDate),
    };
  });
}

// Returns the importer-ready record for one case, or null when the case has
// no Client contact (nothing importable — the ledger records hasClient:false).
function buildStructuredCase(caseId, endpoints, lookup, employeeMap) {
  const contacts = endpoints?.['/CaseContact/_List'];
  if (!contacts) return null;
  const contactList = Array.isArray(contacts[0]?.data) ? contacts[0].data : [];
  const client = contactList.find(c => c.PrimaryRoleName === 'Client');
  if (!client) return null;

  const caseInfo = endpoints?.['/Case/GetData']?.[0] ?? {};
  const titlePart = client.ContactName?.split(', ')[2] ?? '';
  const contactDetails = endpoints?.['/CaseContact/GetData'] ?? [];
  const contactInfoById = new Map(
    contactDetails.map(detail => [detail.ID, detail.ContactInfo ?? {}]),
  );
  const contactInfo = contactInfoById.get(client.ID) ?? {};
  const referrerInfo = endpoints?.referrerContact?.[0]?.ContactInfo ?? {};

  const causeId = nullId(caseInfo.CauseID) ? '' : caseInfo.CauseID;
  const conditionId = nullId(caseInfo.ConditionID) ? '' : caseInfo.ConditionID;
  const employmentStatusId = nullId(caseInfo.EmploymentStatusID) ? '' : caseInfo.EmploymentStatusID;
  const statusId = nullId(caseInfo.StatusID) ? '' : caseInfo.StatusID;
  const categoryId = nullId(caseInfo.CategoryID) ? '' : caseInfo.CategoryID;
  const requirementId = nullId(caseInfo.RequirementID) ? '' : caseInfo.RequirementID;

  const assignedUserId = nullId(caseInfo.AssignedToID) ? '' : caseInfo.AssignedToID;
  const assignedUser = employeeMap[assignedUserId];
  const assignedUserName = assignedUser ? `${assignedUser.firstName} ${assignedUser.lastName}`.trim() : '';
  const assignedUserEmail = assignedUser?.email ?? '';

  const clientAddress = buildAddress(lookup, {
    street: contactInfo.Street,
    suburb: contactInfo.Suburb,
    postalCode: contactInfo.PostalCode,
    regionId: contactInfo.RegionID,
    countryId: contactInfo.CountryID,
  });

  const clientBillingAddress = contactInfo.Address2UsePrimary === false
    ? buildAddress(lookup, {
      street: contactInfo.Street2,
      suburb: contactInfo.Suburb2,
      postalCode: contactInfo.PostalCode2,
      regionId: contactInfo.RegionID2,
      countryId: contactInfo.CountryID2,
    })
    : null;

  const referrer = {
    firstName: referrerInfo.FirstName ?? '',
    lastName: referrerInfo.LastName ?? '',
    email: referrerInfo.Email1 ?? '',
    phone: referrerInfo.Phone1 ?? '',
    fax: referrerInfo.Fax ?? '',
    position: resolveId(lookup, referrerInfo.PositionID),
  };

  // Client and Referrer already migrate as first-class records; QA and
  // Workcom Admin are internal contacts that aren't wanted in NotusPoint
  const EXCLUDED_CONTACT_ROLES = new Set(['Client', 'Referrer', 'QA', 'Workcom Admin']);
  const caseContacts = [];
  for (const row of contactList) {
    const roles = (row.RoleNames ?? '').split(',').map(r => r.trim()).filter(Boolean);
    if (roles.some(role => EXCLUDED_CONTACT_ROLES.has(role))) continue;

    const detail = contactInfoById.get(row.ID) ?? {};
    caseContacts.push({
      firstName: detail.FirstName || row.FirstName || '',
      lastName: detail.LastName || row.LastName || '',
      email: detail.Email1 || row.Email || '',
      company: detail.CompanyName || row.CompanyName || '',
      phone: detail.Mobile || detail.Phone1 || detail.Phone2 || row.Phone || '',
      fax: detail.Fax || '',
      role: row.PrimaryRoleName || roles[0] || '',
      address: buildAddress(lookup, {
        street: detail.Street,
        suburb: detail.Suburb,
        postalCode: detail.PostalCode,
        regionId: detail.RegionID,
        countryId: detail.CountryID,
      }),
    });
  }

  const billingTemplates = buildBillingTemplates(caseId, endpoints);
  const costs = buildCosts(endpoints);

  // Client detail lives on ContactInfo (from /CaseContact/GetData), not the
  // _List row - the row's Phone is often blank while ContactInfo.Mobile is set
  const genderToSex = { M: 'male', F: 'female' };

  return {
    caseId,
    clientTitle: titlePart,
    clientFirstName: client.FirstName ?? '',
    clientLastName: client.LastName ?? '',
    clientEmail: contactInfo.Email1 || client.Email || '',
    clientPhone: contactInfo.Mobile || contactInfo.Phone1 || contactInfo.Phone2 || client.Phone || '',
    clientLandline: contactInfo.Phone1 || contactInfo.Phone2 || '',
    clientSecondaryEmail: contactInfo.Email2 || '',
    clientDateOfBirth: formatDate(contactInfo.DateOfBirth),
    clientSex: genderToSex[contactInfo.Gender] ?? (contactInfo.Gender ? 'other' : ''),
    claimNumber: caseInfo.ClaimNo ?? '',
    billerCode: caseInfo.BillerCode ?? '',
    conditionDate: formatDate(caseInfo.ConditionDate),
    referralDate: formatDate(caseInfo.DateOfReferral),
    dateClosed: formatDate(caseInfo.DateClosed),
    statusId,
    statusDescription: resolveId(lookup, caseInfo.StatusID),
    categoryId,
    categoryDescription: resolveId(lookup, caseInfo.CategoryID),
    requirementId,
    requirementDescription: resolveId(lookup, caseInfo.RequirementID),
    assignedUserId,
    assignedUserName,
    assignedUserEmail,
    clientAddress,
    clientBillingAddress,
    referrer,
    caseContacts,
    employmentStatusId,
    employmentStatusDescription: resolveId(lookup, caseInfo.EmploymentStatusID),
    causeId,
    causeDescription: resolveId(lookup, caseInfo.CauseID),
    conditionId,
    conditionDescription: resolveId(lookup, caseInfo.ConditionID),
    billingTemplates,
    costs,
  };
}

// Compact per-case totals stored in the ledger at export time so the verify
// pass can cross-check later stages without re-reading the raw data files.
function countsFor(structured) {
  if (!structured) return null;
  return {
    contacts: structured.caseContacts.length,
    billingTemplates: structured.billingTemplates.length,
    billingItems: structured.billingTemplates.reduce((n, t) => n + t.items.length, 0),
    costs: structured.costs.length,
  };
}

module.exports = { buildLookupMap, buildEmployeeMap, buildStructuredCase, countsFor };
