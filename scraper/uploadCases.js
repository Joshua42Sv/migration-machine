require("dotenv").config();
const fs = require("fs");
const path = require("path");

const STRUCTURED_FILE =
  process.argv[2] || path.join(__dirname, "structuredData.json");
const DOCUMENTS_DIR = path.join(__dirname, "documents");
const IMPORT_URL =
  process.env.IMPORT_URL || "http://localhost:8080/api/importer/case";
const IMPORT_FILE_URL =
  process.env.IMPORT_FILE_URL || "http://localhost:8080/api/importer/case/file";
const IMPORT_STAFF_URL =
  process.env.IMPORT_STAFF_URL || "http://localhost:8080/api/importer/staff";
const UPLOADED_BY_ID = "5a04e3e0-78bd-4fd8-bd93-a64fe9acb784"; // TODO: Replace with actual user ID, mapped from old to new

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

// Costs can only import against a billing template item in the same payload;
// anything unlinked in the source (or linked to a deleted estimate row) is
// skipped and reported. employeeId is the Case Manager ID, resolved to the
// user the staff import created.
function toCostImportDtos(caseRecord, resolvedUserIdByEmployeeId) {
  const itemIds = new Set(
    (caseRecord.billingTemplates ?? []).flatMap((t) => t.items.map((i) => i.id)),
  );
  const costs = [];
  let skipped = 0;

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
    costs.push(dto);
  }

  return { costs, skipped };
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
    customerId: "cefc5f16-9c6e-4580-996b-9e881a2e7bb2", // TODO: Replace with actual customer ID, mapped from old to new
    requirementId: "ad641c36-2992-4d31-8cdc-5b8890a81427", // TODO: Replace with actual requirement ID, mapped from old to new
  };

  if (caseRecord.clientBillingAddress) {
    dto.clientBillingAddress = caseRecord.clientBillingAddress;
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

async function uploadCaseFile(caseId, entry) {
  const filePath = path.join(DOCUMENTS_DIR, caseId, entry.filename);
  const buffer = fs.readFileSync(filePath);

  const form = new FormData();
  form.append("file", new Blob([buffer]), entry.filename);
  form.append("caseId", caseId);
  form.append("title", entry.title);
  form.append("fileType", entry.fileType);
  form.append("uploadedById", UPLOADED_BY_ID);
  form.append("dateUploaded", entry.dateUploaded || new Date().toISOString());

  const res = await fetch(IMPORT_FILE_URL, { method: "POST", body: form });

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

  console.error(`Total: ${employees.length} staff to upload`);
  console.error(`Target: ${IMPORT_STAFF_URL}\n`);

  const failedStaff = [];
  const resolvedEmailByEmployeeId = new Map();
  const resolvedUserIdByEmployeeId = new Map();
  let staffDone = 0;

  for (const employee of employees) {
    staffDone++;
    const progress = `[${staffDone}/${employees.length}]`;
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
  console.error(`Target: ${IMPORT_URL}\n`);

  const failed = [];
  const failedFiles = [];
  let done = 0;
  let filesUploaded = 0;

  for (const caseRecord of cases) {
    done++;
    const progress = `[${done}/${cases.length}]`;
    const dto = toCaseImportDto(caseRecord, resolvedEmailByEmployeeId);

    const { costs, skipped } = toCostImportDtos(
      caseRecord,
      resolvedUserIdByEmployeeId,
    );
    if (costs.length) dto.costs = costs;
    if (skipped) {
      console.error(
        `    ${skipped} cost(s) on case ${dto.caseId} not linked to an estimate item - skipped`,
      );
    }

    try {
      process.stderr.write(`${progress} Uploading case ${dto.caseId}... `);
      await uploadCase(dto);
      console.error("done");
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      failed.push({ caseId: dto.caseId, error: err.message });
      continue;
    }

    const manifest = loadManifest(dto.caseId);
    for (const entry of manifest) {
      try {
        process.stderr.write(`    Uploading file "${entry.title}"... `);
        await uploadCaseFile(dto.caseId, entry);
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
  if (failedStaff.length) {
    console.error(`${failedStaff.length} staff member(s) failed:`);
    for (const f of failedStaff) console.error(`  - ${f.email}: ${f.error}`);
    process.exitCode = 1;
  }
})();
