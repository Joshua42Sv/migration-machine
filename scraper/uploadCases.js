require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { roots } = require("./lib/paths");
const { loadLedger } = require("./lib/ledger");
const { createLimiter, mapPool } = require("./lib/pool");

const args = process.argv.slice(2);
// --skip-files: upload cases and costs only; costs then import without file
// links, so only use this for quick data-checking runs
const SKIP_FILES = args.includes("--skip-files");
// --costs-without-files: normally costs wait ("blocked") while a case still
// has failed file uploads, so a later resume can import them with their file
// links intact; this forces them through without the links instead
const COSTS_WITHOUT_FILES = args.includes("--costs-without-files");

const paths = roots();
const DATA_DIR = paths.dataDir;
const DOCUMENTS_DIR = paths.documentsDir;
const IMPORT_URL =
  process.env.IMPORT_URL || "http://localhost:8080/api/importer/case";
const IMPORT_FILE_URL =
  process.env.IMPORT_FILE_URL || "http://localhost:8080/api/importer/case/file";
const IMPORT_STAFF_URL =
  process.env.IMPORT_STAFF_URL || "http://localhost:8080/api/importer/staff";
const IMPORT_COSTS_URL =
  process.env.IMPORT_COSTS_URL ||
  "http://localhost:8080/api/importer/case/costs";
// Cases uploaded at once; each case's file POSTs additionally share the
// global file limiter below, which is what actually bounds importer load.
const CASE_CONCURRENCY = Number(process.env.UPLOAD_CASE_CONCURRENCY ?? 8);
const FILE_CONCURRENCY = Number(process.env.UPLOAD_FILE_CONCURRENCY ?? 32);

if (!fs.existsSync(DATA_DIR) || !fs.existsSync(paths.sharedFile)) {
  console.error(`Export data not found (${DATA_DIR} / ${paths.sharedFile})`);
  console.error("Run runAll.js first to export case data");
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

// Per-case file-upload progress (documentId -> NotusPoint file id) lives next
// to the files and is re-saved after EVERY file, so a crash mid-case never
// re-uploads (and so duplicates) files the importer already accepted. It also
// carries the ids costs need for their file links on a resumed run.
function uploadStatePath(caseId) {
  return path.join(DOCUMENTS_DIR, caseId, ".uploadState.json");
}

function loadUploadState(caseId) {
  try {
    return JSON.parse(fs.readFileSync(uploadStatePath(caseId), "utf8"));
  } catch {
    return { byDocumentId: {} };
  }
}

function saveUploadState(caseId, state) {
  fs.writeFileSync(uploadStatePath(caseId), JSON.stringify(state, null, 2));
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
  const ledger = loadLedger(paths.root);
  const { employees } = JSON.parse(fs.readFileSync(paths.sharedFile, "utf8"));

  // Importable records come from the per-case export files; raw endpoint data
  // is dropped as each file is read so only the small structured records stay
  // in memory. Cases without a Client contact export as structured:null and
  // are not importable.
  const caseIds = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.basename(f, ".json"))
    .sort((a, b) => Number(a) - Number(b));
  const cases = [];
  let noClient = 0;
  for (const caseId of caseIds) {
    const { structured } = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, `${caseId}.json`), "utf8"),
    );
    if (structured) cases.push(structured);
    else noClient++;
  }
  if (noClient) {
    console.error(`${noClient} exported case(s) have no Client contact - not importable, skipped`);
  }

  // Only cases whose documents are fully downloaded upload (unless
  // --skip-files); that makes it safe to run this WHILE downloadDocuments.js
  // is still going — re-run it (or loop it) to drain newly finished cases.
  const ready = [];
  let waitingDocs = 0;
  for (const caseRecord of cases) {
    if (!SKIP_FILES && ledger.stageStatus(caseRecord.caseId, "documents") !== "done") {
      waitingDocs++;
      continue;
    }
    ready.push(caseRecord);
  }
  if (waitingDocs) {
    console.error(
      `${waitingDocs} case(s) still waiting for their document download - run the uploader again later to pick them up`,
    );
  }

  // Only employees actually referenced somewhere become NotusPoint users:
  // cost loggers, assigned case users, and document creators (from the
  // manifests, so files can be uploaded as the user who created them)
  const neededEmployeeIds = new Set();
  for (const caseRecord of ready) {
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

  // Staff already imported on a previous run are reused from the ledger (the
  // importer rejects duplicates, and their user ids are needed either way)
  const resolvedEmailByEmployeeId = new Map();
  const resolvedUserIdByEmployeeId = new Map();
  const pendingStaff = [];
  for (const employee of staff) {
    const known = ledger.state.staff[employee.id];
    if (known?.userId) {
      resolvedEmailByEmployeeId.set(employee.id, known.email);
      resolvedUserIdByEmployeeId.set(employee.id, known.userId);
    } else {
      pendingStaff.push(employee);
    }
  }

  console.error(
    `Total: ${staff.length} staff referenced, ${staff.length - pendingStaff.length} already uploaded, ${pendingStaff.length} to upload`,
  );
  console.error(`Target: ${IMPORT_STAFF_URL}\n`);

  const failedStaff = [];
  let staffDone = 0;

  for (const employee of pendingStaff) {
    staffDone++;
    const progress = `[${staffDone}/${pendingStaff.length}]`;
    const dto = toStaffImportDto(employee);
    resolvedEmailByEmployeeId.set(employee.id, dto.email);

    try {
      process.stderr.write(`${progress} Uploading staff ${dto.email}... `);
      const user = await uploadStaff(dto);
      if (user?.id) resolvedUserIdByEmployeeId.set(employee.id, user.id);
      ledger.setStaff(employee.id, { email: dto.email, userId: user?.id ?? "" });
      console.error("done");
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      failedStaff.push({ email: dto.email, error: err.message });
    }
  }

  if (pendingStaff.length) {
    console.error(
      `\nFinished staff. ${staffDone - failedStaff.length}/${staffDone} uploaded successfully.\n`,
    );
  }

  console.error(`Total: ${ready.length} case(s) ready to upload`);
  console.error(`Target: ${IMPORT_URL}`);
  if (SKIP_FILES) {
    console.error("--skip-files: file uploads disabled, costs will have no file links");
  }
  console.error("");

  const failed = [];
  const failedFiles = [];
  const failedCosts = [];
  let alreadyComplete = 0;
  let filesUploaded = 0;
  let filesSkipped = 0;
  let costsBlocked = 0;
  let completedCases = 0;
  // Bounds concurrent file POSTs across ALL case workers, so importer load
  // stays capped no matter how case work is distributed
  const fileLimiter = createLimiter(FILE_CONCURRENCY);

  // Order per case: case (with billing templates) -> files -> costs, so costs
  // can reference the file ids the file import created. Each part is tracked
  // in the ledger and skipped once done, so a resumed run never re-POSTs
  // (and so never duplicates) work the importer already accepted.
  // Returns a summary string for the progress line, or null when the case was
  // already fully uploaded.
  async function uploadOneCase(caseRecord) {
    const caseId = caseRecord.caseId;
    const up = ledger.getCase(caseId).upload ?? {};
    const parts = [];

    const manifest = SKIP_FILES ? [] : loadManifest(caseId);
    const caseDone = up.case?.status === "done";
    const filesDone = up.files?.status === "done" && (up.files.uploaded ?? 0) >= manifest.length;
    const costsDone = up.costs?.status === "done";
    if (caseDone && filesDone && costsDone) {
      alreadyComplete++;
      return null;
    }

    // 1. The case itself (with billing templates)
    if (!caseDone) {
      const dto = toCaseImportDto(caseRecord, resolvedEmailByEmployeeId);
      try {
        await uploadCase(dto);
        ledger.updateStage(caseId, "upload", { case: { status: "done" } });
        parts.push("case ok");
      } catch (err) {
        ledger.updateStage(caseId, "upload", { case: { status: "failed", error: err.message } });
        failed.push({ caseId, error: err.message });
        return `case FAILED: ${err.message}`;
      }
    }

    // 2. Files, in parallel through the shared limiter. Each uploads as the
    // user who created the document in Case Manager; when that can't be
    // resolved (no createdById, or the staff upload failed) fall back to the
    // case's assigned user, then any imported staff member
    const fallbackUploaderId =
      resolvedUserIdByEmployeeId.get(caseRecord.assignedUserId) ||
      resolvedUserIdByEmployeeId.values().next().value;

    const uploadState = loadUploadState(caseId);
    const entryKey = (entry) => entry.documentId || entry.filename;
    const pendingEntries = manifest.filter(
      (entry) => uploadState.byDocumentId[entryKey(entry)] === undefined,
    );
    filesSkipped += manifest.length - pendingEntries.length;

    let caseFileFailures = 0;
    await Promise.all(
      pendingEntries.map((entry) =>
        fileLimiter(async () => {
          const uploadedById =
            resolvedUserIdByEmployeeId.get(entry.createdById) || fallbackUploaderId;
          try {
            const file = await uploadCaseFile(caseId, entry, uploadedById);
            uploadState.byDocumentId[entryKey(entry)] = file?.id ?? "";
            saveUploadState(caseId, uploadState);
            filesUploaded++;
          } catch (err) {
            caseFileFailures++;
            failedFiles.push({ caseId, filename: entry.filename, error: err.message });
            console.error(`  file "${entry.filename}" on case ${caseId} FAILED: ${err.message}`);
          }
        }),
      ),
    );
    if (!SKIP_FILES) {
      ledger.updateStage(caseId, "upload", {
        files: {
          status: caseFileFailures ? "failed" : "done",
          expected: manifest.length,
          uploaded: Object.keys(uploadState.byDocumentId).length,
          failed: caseFileFailures,
        },
      });
      parts.push(`files ${Object.keys(uploadState.byDocumentId).length}/${manifest.length}`);
    }

    // 3. Costs — one batch per case. While files are still failing the batch
    // is held back ("blocked") so a later retry can import the costs WITH
    // their file links; --costs-without-files forces them through instead.
    if (!costsDone) {
      if (caseFileFailures && !SKIP_FILES && !COSTS_WITHOUT_FILES) {
        costsBlocked++;
        ledger.updateStage(caseId, "upload", {
          costs: { status: "blocked", note: "waiting for failed file uploads" },
        });
        parts.push("costs held back (failed files; re-run to retry)");
        return parts.join(", ");
      }

      const fileIdByDocumentId = new Map(
        Object.entries(uploadState.byDocumentId).filter(([, id]) => id),
      );
      const { costs, skipped, unmatchedDocuments } = toCostImportDtos(
        caseRecord,
        resolvedUserIdByEmployeeId,
        fileIdByDocumentId,
      );
      if (skipped) {
        parts.push(`${skipped} cost(s) not linked to an estimate item - skipped`);
      }
      if (unmatchedDocuments && !SKIP_FILES) {
        parts.push(`${unmatchedDocuments} cost(s) missing their file link`);
      }
      try {
        if (costs.length) await uploadCosts(caseId, costs);
        ledger.updateStage(caseId, "upload", {
          costs: {
            status: "done",
            expected: (caseRecord.costs ?? []).length,
            imported: costs.length,
            skippedUnlinked: skipped,
            missingFileLinks: unmatchedDocuments,
            error: undefined,
            note: undefined,
          },
        });
        parts.push(`costs ${costs.length} imported`);
      } catch (err) {
        ledger.updateStage(caseId, "upload", {
          costs: { status: "failed", error: err.message },
        });
        failedCosts.push({ caseId, error: err.message });
        parts.push(`costs FAILED: ${err.message}`);
      }
    }

    return parts.join(", ");
  }

  await mapPool(ready, CASE_CONCURRENCY, async (caseRecord) => {
    const summary = await uploadOneCase(caseRecord);
    completedCases++;
    if (summary) {
      console.error(`[${completedCases}/${ready.length}] Case ${caseRecord.caseId}: ${summary}`);
    }
  });

  const attempted = ready.length - alreadyComplete;
  console.error(
    `\nFinished. ${attempted - failed.length}/${attempted} case(s) uploaded successfully` +
      (alreadyComplete ? ` (${alreadyComplete} already complete, skipped)` : "") + ".",
  );
  console.error(
    `${filesUploaded} file(s) uploaded, ${filesSkipped} already uploaded, ${failedFiles.length} failed.`,
  );
  if (waitingDocs) {
    console.error(`${waitingDocs} case(s) still waiting for documents - re-run to pick them up.`);
  }
  if (costsBlocked) {
    console.error(`${costsBlocked} case(s) have costs held back behind failed file uploads.`);
  }
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
