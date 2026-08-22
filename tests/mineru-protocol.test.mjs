import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePdfWithMineru, readMineruAsset } from "../lib/mineru.js";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(files) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-paper-reader-mineru-test-"));
const fakeToken = `fixture_${"x".repeat(40)}`;
const configValues = {
  mineruApiToken: fakeToken,
  mineruApiBaseUrl: "https://mineru.net/api/v4",
  mineruModelVersion: "vlm",
  mineruLanguage: "en",
  mineruEnableFormula: true,
  mineruEnableTable: false,
  mineruOcr: true,
  mineruTimeoutSeconds: 60,
  mineruPollIntervalSeconds: 2,
};
const structured = [
  {
    type: "text",
    page_idx: 0,
    bbox: [20, 30, 980, 100],
    text: [
      { type: "text", content: "A paragraph with" },
      { type: "equation_inline", math_content: "x^2" },
      { type: "text", content: "inline math." },
    ],
  },
  {
    type: "image",
    page_idx: 0,
    bbox: [100, 130, 900, 500],
    img_path: "images/figure.png",
    image_caption: ["Figure 1. Test image."],
  },
  {
    type: "table",
    page_idx: 0,
    bbox: [100, 520, 900, 780],
    img_path: "images/table.png",
    table_caption: ["Table 1. Test table."],
    table_body: "<table><tr><th>A</th></tr><tr><td>1</td></tr></table>",
  },
  {
    type: "equation",
    page_idx: 0,
    bbox: [180, 800, 820, 900],
    math_content: "E=mc^2",
    equation_caption: "Mass-energy equivalence.",
  },
  {
    type: "image",
    page_idx: 0,
    bbox: [0, 0, 10, 10],
    img_path: "../escape.png",
    image_caption: ["Unsafe path must not resolve."],
  },
];
const zipBytes = storedZip({
  "fixture/content_list_v2.json": JSON.stringify(structured),
  "fixture/images/figure.png": Buffer.from("figure-bytes"),
  "fixture/images/table.png": Buffer.from("table-bytes"),
  "fixture/images/orphan.png": Buffer.from("orphan-must-not-be-cached"),
  "../escape.png": Buffer.from("escape-must-never-be-written"),
});

let requestBody;
let uploadDataId;
const calls = [];
const ctx = {
  dataDir,
  config: { get: (key) => configValues[key] },
  network: {
    async fetch(url, init = {}) {
      calls.push({ url: String(url), method: init.method || "GET" });
      if (url === "https://mineru.net/api/v4/file-urls/batch") {
        assert.equal(init.method, "POST");
        assert.equal(init.headers.Authorization, `Bearer ${fakeToken}`);
        requestBody = JSON.parse(init.body);
        uploadDataId = requestBody.files[0].data_id;
        return jsonResponse({
          code: 0,
          msg: "ok",
          data: {
            batch_id: "fixture-batch",
            file_urls: ["https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/fixture"],
          },
        });
      }
      if (url === "https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/fixture") {
        assert.equal(init.method, "PUT");
        assert.equal(init.headers, undefined, "signed PUT must not add headers");
        assert.ok(Buffer.isBuffer(init.body));
        assert.equal(init.body.subarray(0, 5).toString("ascii"), "%PDF-");
        return new Response(null, { status: 200 });
      }
      if (url === "https://mineru.net/api/v4/extract-results/batch/fixture-batch") {
        assert.equal(init.method, "GET");
        assert.equal(init.headers.Authorization, `Bearer ${fakeToken}`);
        return jsonResponse({
          code: 0,
          msg: "ok",
          data: {
            batch_id: "fixture-batch",
            extract_result: [{
              file_name: "fixture.pdf",
              data_id: uploadDataId,
              state: "done",
              full_zip_url: "https://cdn-mineru.openxlab.org.cn/fixture/result.zip",
            }],
          },
        });
      }
      if (url === "https://cdn-mineru.openxlab.org.cn/fixture/result.zip") {
        assert.equal(init.method, "GET");
        return new Response(zipBytes, { status: 200, headers: { "Content-Type": "application/zip" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  },
};

try {
  const result = await parsePdfWithMineru({
    buffer: Buffer.from("%PDF-1.4\nfixture\n%%EOF\n"),
    fileName: "fixture.pdf",
    ctx,
  });

  assert.deepEqual(Object.keys(requestBody).sort(), [
    "enable_formula",
    "enable_table",
    "files",
    "language",
    "model_version",
  ]);
  assert.deepEqual(Object.keys(requestBody.files[0]).sort(), ["data_id", "is_ocr", "name"]);
  assert.equal(requestBody.model_version, "vlm");
  assert.equal(requestBody.enable_formula, true);
  assert.equal(requestBody.enable_table, false);
  assert.equal(requestBody.language, "en");
  assert.equal(requestBody.files[0].name, "fixture.pdf");
  assert.equal(requestBody.files[0].is_ocr, true);
  assert.match(requestBody.files[0].data_id, /^hana_paper_\d+_[a-f0-9]{12}_ocr1$/);
  assert.ok(!calls[0].url.includes("?"), "batch options must not be query parameters");

  assert.equal(result.ok, true);
  assert.equal(result.parser, "mineru");
  assert.equal(result.modelVersion, "vlm");
  assert.equal(result.ocrUsed, true);
  assert.equal(result.ocrFallback, false);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.pageCount, 1);
  assert.equal(result.blockCount, 5);
  assert.match(result.blocks[0].text, /\$x\^2\$/);
  assert.equal(result.blocks[1].assetRef.path, "fixture/images/figure.png");
  assert.equal(result.blocks[2].assetRef.path, "fixture/images/table.png");
  assert.match(result.blocks[2].tableHtml, /^<table>/);
  assert.equal(result.blocks[3].latex, "E=mc^2");
  assert.equal(result.blocks[4].assetRef, null);

  const image = readMineruAsset({
    ctx,
    cacheId: result.blocks[1].assetRef.cacheId,
    assetPath: result.blocks[1].assetRef.path,
  });
  assert.equal(image.contentType, "image/png");
  assert.equal(image.bytes.toString("utf8"), "figure-bytes");
  assert.equal(readMineruAsset({
    ctx,
    cacheId: result.blocks[1].assetRef.cacheId,
    assetPath: "fixture/images/orphan.png",
  }), null, "unreferenced assets must not be cached");
  assert.equal(readMineruAsset({
    ctx,
    cacheId: result.blocks[1].assetRef.cacheId,
    assetPath: "../escape.png",
  }), null, "path traversal must be blocked");
  assert.equal(fs.existsSync(path.join(dataDir, "escape.png")), false);

  const fallbackBodies = [];
  const fallbackWarnings = [];
  let fallbackUploadIndex = 0;
  const fallbackContext = {
    ...ctx,
    config: {
      get(key) {
        if (key === "mineruOcr") return false;
        return configValues[key];
      },
    },
    log: { warn: (message) => fallbackWarnings.push(String(message)) },
    network: {
      async fetch(url, init = {}) {
        if (url === "https://mineru.net/api/v4/file-urls/batch") {
          const body = JSON.parse(init.body);
          fallbackBodies.push(body);
          fallbackUploadIndex += 1;
          return jsonResponse({
            code: 0,
            msg: "ok",
            data: {
              batch_id: `fallback-batch-${fallbackUploadIndex}`,
              file_urls: [`https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/fallback-${fallbackUploadIndex}`],
            },
          });
        }
        if (/^https:\/\/mineru\.oss-cn-shanghai\.aliyuncs\.com\/api-upload\/fallback-[12]$/.test(url)) {
          assert.equal(init.method, "PUT");
          return new Response(null, { status: 200 });
        }
        if (url === "https://mineru.net/api/v4/extract-results/batch/fallback-batch-1") {
          return jsonResponse({
            code: 0,
            msg: "ok",
            data: {
              extract_result: [{
                data_id: fallbackBodies[0].files[0].data_id,
                file_name: "fallback.pdf",
                state: "failed",
                err_msg: "parsing failed, please try again later",
              }],
            },
          });
        }
        if (url === "https://mineru.net/api/v4/extract-results/batch/fallback-batch-2") {
          return jsonResponse({
            code: 0,
            msg: "ok",
            data: {
              extract_result: [{
                data_id: fallbackBodies[1].files[0].data_id,
                file_name: "fallback.pdf",
                state: "done",
                full_zip_url: "https://cdn-mineru.openxlab.org.cn/fallback/result.zip",
              }],
            },
          });
        }
        if (url === "https://cdn-mineru.openxlab.org.cn/fallback/result.zip") {
          return new Response(zipBytes, { status: 200, headers: { "Content-Type": "application/zip" } });
        }
        throw new Error(`unexpected fallback URL: ${url}`);
      },
    },
  };
  const fallbackResult = await parsePdfWithMineru({
    buffer: Buffer.from("%PDF-1.4\nfallback\n%%EOF\n"),
    fileName: "fallback.pdf",
    ctx: fallbackContext,
  });
  assert.equal(fallbackBodies.length, 2);
  assert.equal(fallbackBodies[0].files[0].is_ocr, false);
  assert.equal(fallbackBodies[1].files[0].is_ocr, true);
  assert.match(fallbackBodies[0].files[0].data_id, /_std1$/);
  assert.match(fallbackBodies[1].files[0].data_id, /_ocr2$/);
  assert.equal(fallbackResult.ok, true);
  assert.equal(fallbackResult.ocrUsed, true);
  assert.equal(fallbackResult.ocrFallback, true);
  assert.equal(fallbackResult.attemptCount, 2);
  assert.equal(fallbackWarnings.length, 1);
  assert.match(fallbackWarnings[0], /OCR 模式重试/);

  const noOcrConfig = {
    get(key) {
      if (key === "mineruOcr") return false;
      return configValues[key];
    },
  };

  let authBatchRequests = 0;
  await assert.rejects(
    () => parsePdfWithMineru({
      buffer: Buffer.from("%PDF-1.4\nauth\n%%EOF\n"),
      fileName: "auth.pdf",
      ctx: {
        ...ctx,
        config: noOcrConfig,
        network: {
          async fetch(url) {
            assert.equal(url, "https://mineru.net/api/v4/file-urls/batch");
            authBatchRequests += 1;
            return jsonResponse({ code: 401, msg: "Unauthorized" }, 401);
          },
        },
      },
    }),
    /申请 MinerU 上传地址.*HTTP 401/,
  );
  assert.equal(authBatchRequests, 1, "authentication failures must not retry with OCR");

  let uploadBatchRequests = 0;
  let uploadPutRequests = 0;
  await assert.rejects(
    () => parsePdfWithMineru({
      buffer: Buffer.from("%PDF-1.4\nupload\n%%EOF\n"),
      fileName: "upload.pdf",
      ctx: {
        ...ctx,
        config: noOcrConfig,
        network: {
          async fetch(url) {
            if (url === "https://mineru.net/api/v4/file-urls/batch") {
              uploadBatchRequests += 1;
              return jsonResponse({
                code: 0,
                msg: "ok",
                data: {
                  batch_id: "upload-failure-batch",
                  file_urls: ["https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/upload-failure"],
                },
              });
            }
            if (url === "https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/upload-failure") {
              uploadPutRequests += 1;
              return new Response(null, { status: 500 });
            }
            throw new Error(`unexpected upload failure URL: ${url}`);
          },
        },
      },
    }),
    /上传 PDF 到 MinerU.*HTTP 500/,
  );
  assert.equal(uploadBatchRequests, 1, "upload failures must not request a second batch");
  assert.equal(uploadPutRequests, 1, "upload failures must not retry the signed PUT");

  let downloadBatchRequests = 0;
  let downloadRequests = 0;
  let downloadDataId = "";
  await assert.rejects(
    () => parsePdfWithMineru({
      buffer: Buffer.from("%PDF-1.4\ndownload\n%%EOF\n"),
      fileName: "download.pdf",
      ctx: {
        ...ctx,
        config: noOcrConfig,
        network: {
          async fetch(url, init = {}) {
            if (url === "https://mineru.net/api/v4/file-urls/batch") {
              downloadBatchRequests += 1;
              downloadDataId = JSON.parse(init.body).files[0].data_id;
              return jsonResponse({
                code: 0,
                msg: "ok",
                data: {
                  batch_id: "download-failure-batch",
                  file_urls: ["https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/download-failure"],
                },
              });
            }
            if (url === "https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/download-failure") {
              return new Response(null, { status: 200 });
            }
            if (url === "https://mineru.net/api/v4/extract-results/batch/download-failure-batch") {
              return jsonResponse({
                code: 0,
                msg: "ok",
                data: {
                  extract_result: [{
                    data_id: downloadDataId,
                    file_name: "download.pdf",
                    state: "done",
                    full_zip_url: "https://cdn-mineru.openxlab.org.cn/download-failure/result.zip",
                  }],
                },
              });
            }
            if (url === "https://cdn-mineru.openxlab.org.cn/download-failure/result.zip") {
              downloadRequests += 1;
              return new Response(null, { status: 503 });
            }
            throw new Error(`unexpected download failure URL: ${url}`);
          },
        },
      },
    }),
    /下载 MinerU 结果.*HTTP 503/,
  );
  assert.equal(downloadBatchRequests, 1, "ZIP download failures must not request an OCR batch");
  assert.equal(downloadRequests, 1, "ZIP download failures must not retry automatically");

  const rejectedRequests = [];
  const maliciousContext = {
    ...ctx,
    network: {
      async fetch(url, init = {}) {
        rejectedRequests.push(String(url));
        if (url === "https://mineru.net/api/v4/file-urls/batch") {
          return jsonResponse({
            code: 0,
            msg: "ok",
            data: {
              batch_id: "malicious-batch",
              file_urls: ["https://attacker.invalid/upload"],
            },
          });
        }
        throw new Error(`unexpected network request after malicious URL: ${url}`);
      },
    },
  };
  await assert.rejects(
    () => parsePdfWithMineru({
      buffer: Buffer.from("%PDF-1.4\nfixture\n%%EOF\n"),
      fileName: "malicious.pdf",
      ctx: maliciousContext,
    }),
    /不是允许的官方 HTTPS 地址/,
  );
  assert.deepEqual(rejectedRequests, ["https://mineru.net/api/v4/file-urls/batch"]);

  console.log("mineru protocol fixture: ok");
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
