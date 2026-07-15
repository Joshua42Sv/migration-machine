require("dotenv").config();
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
// --skip-files: upload cases and costs only; costs then import without file
// links, so only use this for quick data-checking runs
const SKIP_FILES = args.includes("--skip-files");
const STRUCTURED_FILE =
  args.find((a) => !a.startsWith("--")) ||
  path.join(__dirname, "structuredData.json");
const DOCUMENTS_DIR = path.join(__dirname, "documents");
const IMPORT_URL =
  process.env.IMPORT_URL || "http://localhost:8080/api/importer/case";
const IMPORT_FILE_URL =
  process.env.IMPORT_FILE_URL || "http://localhost:8080/api/importer/case/file";
const IMPORT_STAFF_URL =
  process.env.IMPORT_STAFF_URL || "http://localhost:8080/api/importer/staff";
const IMPORT_COSTS_URL =
  process.env.IMPORT_COSTS_URL ||
  "http://localhost:8080/api/importer/case/costs";

if (!fs.existsSync(STRUCTURED_FILE)) {
  console.error(`Structured data file not found: ${STRUCTURED_FILE}`);
  console.error("Run runAll.js first to generate structuredData.json");
  process.exit(1);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function randomEmail() {
  const digits = Math.floor(100000000 + Math.random() * 900000000);
  return `${digits}@example.com`;
}

function toStaffImportDto(employee) {
  const email = EMAIL_PATTERN.test(employee.email)
    ? employee.email
    : randomEmail();

  const dto = {
    firstName: employee.firstName || "Unknown",
    lastName: employee.lastName || "Unknown",
    email,
  };

  if (employee.phone) dto.phone = employee.phone;

  return dto;
}

// Costs import in a second pass (after the case and its files) so each cost
// can link to the NotusPoint file created from its Case Manager document.
// Costs unlinked in the source (or linked to a deleted estimate row) are
// skipped and reported; costs whose document didn't upload just lose the file
// link. employeeId is the Case Manager ID, resolved to the user the staff
// import created.
function toCostImportDtos(
  caseRecord,
  resolvedUserIdByEmployeeId,
  fileIdByDocumentId,
) {
  const itemIds = new Set(
    (caseRecord.billingTemplates ?? []).flatMap((t) =>
      t.items.map((i) => i.id),
    ),
  );
  const costs = [];
  let skipped = 0;
  let unmatchedDocuments = 0;

  for (const cost of caseRecord.costs ?? []) {
    if (!itemIds.has(cost.billingInstanceItemId)) {
      skipped++;
      continue;
    }
    const dto = {
      status: cost.status,
      quantity: cost.quantity,
      rate: cost.rate,
      total: cost.total,
      billingInstanceItemId: cost.billingInstanceItemId,
      date: cost.date,
      createdAt: cost.createdAt,
    };
    const userId = resolvedUserIdByEmployeeId.get(cost.employeeId);
    if (userId) dto.userId = userId;
    if (cost.documentId) {
      const fileId = fileIdByDocumentId.get(cost.documentId);
      if (fileId) dto.fileId = fileId;
      else unmatchedDocuments++;
    }
    costs.push(dto);
  }

  return { costs, skipped, unmatchedDocuments };
}

function toCaseImportDto(caseRecord, resolvedEmailByEmployeeId) {
  const address = caseRecord.clientAddress || {};
  const referrer = caseRecord.referrer || {};

  const dto = {
    caseId: caseRecord.caseId,
    clientFirstName: caseRecord.clientFirstName || "Unknown",
    clientLastName: caseRecord.clientLastName || "Unknown",
    clientEmail: caseRecord.clientEmail || "unknown@example.com",
    clientPhone: caseRecord.clientPhone || "0000 0000 0000",
    clientTitle: caseRecord.clientTitle || "Unknown",
    claimNumber: caseRecord.claimNumber || "Unknown",
    referralDate: caseRecord.referralDate || "Unknown",
    dateClosed: caseRecord.dateClosed || "",
    clientAddress: {
      addressLine1: address.addressLine1 || "Unknown",
      addressLine2: address.addressLine2 || "",
      suburb: address.suburb || "Unknown",
      state: address.state || "Unknown",
      postcode: address.postcode || "0000",
      country: address.country || "Unknown",
    },
    referrer: {
      firstName: referrer.firstName || "Unknown",
      lastName: referrer.lastName || "Unknown",
      email: referrer.email || "unknown@example.com",
      phone: referrer.phone || "",
      fax: referrer.fax || "",
      position: referrer.position || "",
    },
    customerId: "b6db684c-1bfa-479d-93ad-0d6d4402966a", // TODO: Replace with actual customer ID, mapped from old to new
    requirementId: "64360683-a5bd-4262-b82f-12800e9f96b9", // TODO: Replace with actual requirement ID, mapped from old to new
  };

  // Status text ("Open") maps onto NotusPoint's CaseStatus enum; the importer
  // rejects values it doesn't recognise rather than guessing
  if (caseRecord.statusDescription) dto.status = caseRecord.statusDescription;
  if (caseRecord.billerCode) dto.billerCode = caseRecord.billerCode;
  if (caseRecord.conditionDate) dto.conditionDate = caseRecord.conditionDate;
  // Lookup descriptions from Case Manager; the importer matches them against
  // the configurable lists (case-insensitively) or creates new entries
  if (caseRecord.causeDescription) dto.cause = caseRecord.causeDescription;
  if (caseRecord.conditionDescription) {
    dto.condition = caseRecord.conditionDescription;
  }
  if (caseRecord.employmentStatusDescription) {
    dto.employmentStatus = caseRecord.employmentStatusDescription;
  }

  if (caseRecord.clientDateOfBirth) {
    dto.clientDateOfBirth = caseRecord.clientDateOfBirth;
  }
  if (caseRecord.clientSex) dto.clientSex = caseRecord.clientSex;
  if (caseRecord.clientLandline) dto.clientLandline = caseRecord.clientLandline;
  if (caseRecord.clientSecondaryEmail) {
    dto.clientSecondaryEmail = caseRecord.clientSecondaryEmail;
  }

  if (caseRecord.clientBillingAddress) {
    dto.clientBillingAddress = caseRecord.clientBillingAddress;
  }

  if (caseRecord.caseContacts?.length) {
    // Truncation matches NotusPoint's column lengths (phone/fax 20, most
    // text 100, address lines 200)
    const cut = (value, max) => (value || "").slice(0, max);
    dto.contacts = caseRecord.caseContacts.map((c) => {
      const contact = {
        firstName: cut(c.firstName, 100) || "Unknown",
        lastName: cut(c.lastName, 100) || "Unknown",
        email: cut(c.email, 100) || "unknown@example.com",
      };
      if (c.company) contact.company = cut(c.company, 100);
      if (c.phone) contact.phone = cut(c.phone, 20);
      if (c.fax) contact.fax = cut(c.fax, 20);
      if (c.role) contact.role = c.role;
      const address = c.address ?? {};
      if (address.addressLine1) contact.addressLine1 = cut(address.addressLine1, 200);
      if (address.addressLine2) contact.addressLine2 = cut(address.addressLine2, 200);
      if (address.suburb) contact.suburb = cut(address.suburb, 100);
      if (address.postcode) contact.postcode = cut(address.postcode, 20);
      if (address.state) contact.state = cut(address.state, 100);
      if (address.country) contact.country = cut(address.country, 100);
      return contact;
    });
  }

  if (caseRecord.billingTemplates?.length) {
    dto.billingTemplates = caseRecord.billingTemplates;
  }

  const assignedUserEmail = resolvedEmailByEmployeeId.get(
    caseRecord.assignedUserId,
  );
  if (assignedUserEmail) {
    dto.assignedUserEmail = assignedUserEmail;
  }

  return dto;
}

async function uploadStaff(dto) {
  const res = await fetch(IMPORT_STAFF_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dto),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`,
    );
  }

  // The created user; its id is needed to link costs to their logging user
  return res.json();
}

async function uploadCase(dto) {
  const res = await fetch(IMPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dto),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`,
    );
  }
}

function loadManifest(caseId) {
  const manifestPath = path.join(DOCUMENTS_DIR, caseId, "manifest.json");
  if (!fs.existsSync(manifestPath)) return [];
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

async function uploadCaseFile(caseId, entry, uploadedById) {
  const filePath = path.join(DOCUMENTS_DIR, caseId, entry.filename);
  const buffer = fs.readFileSync(filePath);

  const form = new FormData();
  form.append("file", new Blob([buffer]), entry.filename);
  form.append("caseId", caseId);
  form.append("title", entry.title);
  form.append("fileType", entry.fileType);
  form.append("uploadedById", uploadedById);
  form.append("dateUploaded", entry.dateUploaded || new Date().toISOString());

  const res = await fetch(IMPORT_FILE_URL, { method: "POST", body: form });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`,
    );
  }

  // The created case file; its id links costs to the file they came from
  return res.json();
}

async function uploadCosts(caseId, costs) {
  const res = await fetch(IMPORT_COSTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caseId, costs }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`,
    );
  }
}

(async () => {
  const { cases, employees } = JSON.parse(
    fs.readFileSync(STRUCTURED_FILE, "utf8"),
  );

  // Only employees actually referenced somewhere become NotusPoint users:
  // cost loggers, assigned case users, and document creators (from the
  // manifests, so files can be uploaded as the user who created them)
  const neededEmployeeIds = new Set();
  for (const caseRecord of cases) {
    if (caseRecord.assignedUserId) {
      neededEmployeeIds.add(caseRecord.assignedUserId);
    }
    for (const cost of caseRecord.costs ?? []) {
      if (cost.employeeId) neededEmployeeIds.add(cost.employeeId);
    }
    for (const entry of loadManifest(caseRecord.caseId)) {
      if (entry.createdById) neededEmployeeIds.add(entry.createdById);
    }
  }
  const staff = employees.filter((e) => neededEmployeeIds.has(e.id));

  console.error(
    `Total: ${staff.length} staff to upload (${employees.length - staff.length} unreferenced employee(s) skipped)`,
  );
  console.error(`Target: ${IMPORT_STAFF_URL}\n`);

  const failedStaff = [];
  const resolvedEmailByEmployeeId = new Map();
  const resolvedUserIdByEmployeeId = new Map();
  let staffDone = 0;

  for (const employee of staff) {
    staffDone++;
    const progress = `[${staffDone}/${staff.length}]`;
    const dto = toStaffImportDto(employee);
    resolvedEmailByEmployeeId.set(employee.id, dto.email);

    try {
      process.stderr.write(`${progress} Uploading staff ${dto.email}... `);
      const user = await uploadStaff(dto);
      if (user?.id) resolvedUserIdByEmployeeId.set(employee.id, user.id);
      console.error("done");
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      failedStaff.push({ email: dto.email, error: err.message });
    }
  }

  console.error(
    `\nFinished. ${staffDone - failedStaff.length}/${staffDone} staff uploaded successfully.\n`,
  );

  console.error(`Total: ${cases.length} cases to upload`);
  console.error(`Target: ${IMPORT_URL}`);
  if (SKIP_FILES) {
    console.error("--skip-files: file uploads disabled, costs will have no file links");
  }
  console.error("");

  const failed = [];
  const failedFiles = [];
  const failedCosts = [];
  let done = 0;
  let filesUploaded = 0;

  // Order per case: case (with billing templates) -> files -> costs, so costs
  // can reference the file ids the file import created.
  for (const caseRecord of cases) {
    done++;
    const progress = `[${done}/${cases.length}]`;
    const dto = toCaseImportDto(caseRecord, resolvedEmailByEmployeeId);

    try {
      process.stderr.write(`${progress} Uploading case ${dto.caseId}... `);
      await uploadCase(dto);
      console.error("done");
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      failed.push({ caseId: dto.caseId, error: err.message });
      continue;
    }

    // Each file uploads as the user who created the document in Case
    // Manager; when that can't be resolved (no createdById, or the staff
    // upload failed) fall back to the case's assigned user, then any
    // imported staff member
    const fallbackUploaderId =
      resolvedUserIdByEmployeeId.get(caseRecord.assignedUserId) ||
      resolvedUserIdByEmployeeId.values().next().value;

    const fileIdByDocumentId = new Map();
    const manifest = SKIP_FILES ? [] : loadManifest(dto.caseId);
    for (const entry of manifest) {
      const uploadedById =
        resolvedUserIdByEmployeeId.get(entry.createdById) || fallbackUploaderId;
      try {
        process.stderr.write(`    Uploading file "${entry.title}"... `);
        const file = await uploadCaseFile(dto.caseId, entry, uploadedById);
        if (entry.documentId && file?.id) {
          fileIdByDocumentId.set(entry.documentId, file.id);
        }
        filesUploaded++;
        console.error("done");
      } catch (err) {
        console.error(`FAILED: ${err.message}`);
        failedFiles.push({
          caseId: dto.caseId,
          filename: entry.filename,
          error: err.message,
        });
      }
    }

    const { costs, skipped, unmatchedDocuments } = toCostImportDtos(
      caseRecord,
      resolvedUserIdByEmployeeId,
      fileIdByDocumentId,
    );
    if (skipped) {
      console.error(
        `    ${skipped} cost(s) on case ${dto.caseId} not linked to an estimate item - skipped`,
      );
    }
    if (unmatchedDocuments && !SKIP_FILES) {
      console.error(
        `    ${unmatchedDocuments} cost(s) on case ${dto.caseId} reference a document with no uploaded file - imported without file link`,
      );
    }
    if (costs.length) {
      try {
        process.stderr.write(
          `    Uploading ${costs.length} cost(s) for case ${dto.caseId}... `,
        );
        await uploadCosts(dto.caseId, costs);
        console.error("done");
      } catch (err) {
        console.error(`FAILED: ${err.message}`);
        failedCosts.push({ caseId: dto.caseId, error: err.message });
      }
    }
  }

  console.error(
    `\nFinished. ${done - failed.length}/${done} cases uploaded successfully.`,
  );
  console.error(
    `${filesUploaded} file(s) uploaded, ${failedFiles.length} failed.`,
  );
  if (failed.length) {
    console.error(`${failed.length} case(s) failed:`);
    for (const f of failed) console.error(`  - ${f.caseId}: ${f.error}`);
    process.exitCode = 1;
  }
  if (failedFiles.length) {
    console.error(`${failedFiles.length} file(s) failed:`);
    for (const f of failedFiles)
      console.error(`  - ${f.caseId}/${f.filename}: ${f.error}`);
    process.exitCode = 1;
  }
  if (failedCosts.length) {
    console.error(`${failedCosts.length} case(s) had cost upload failures:`);
    for (const f of failedCosts) console.error(`  - ${f.caseId}: ${f.error}`);
    process.exitCode = 1;
  }
  if (failedStaff.length) {
    console.error(`${failedStaff.length} staff member(s) failed:`);
    for (const f of failedStaff) console.error(`  - ${f.email}: ${f.error}`);
    process.exitCode = 1;
  }
})();
