const puppeteer = require("puppeteer");
const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE_URL = "https://docs.ifalabs.com";
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;
const OUTPUT_DIR = path.join(__dirname, "../pdfs");

// Create HTTPS agent to bypass broken SSL certs
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

// Fetch and parse sitemap
async function fetchSitemap() {
  try {
    console.log("Fetching sitemap...");

    const response = await axios.get(SITEMAP_URL, {
      httpsAgent,
      timeout: 30000,
    });

    const xml = response.data;

    const parsed = await xml2js.parseStringPromise(xml);

    // Handle normal sitemap
    if (parsed.urlset && parsed.urlset.url) {
      return parsed.urlset.url.map((entry) => entry.loc[0]);
    }

    // Handle sitemap index
    if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
      const sitemapLinks = parsed.sitemapindex.sitemap.map(
        (entry) => entry.loc[0]
      );

      let allUrls = [];

      for (const sitemap of sitemapLinks) {
        console.log(`Fetching nested sitemap: ${sitemap}`);

        const nestedResponse = await axios.get(sitemap, {
          httpsAgent,
          timeout: 30000,
        });

        const nestedParsed = await xml2js.parseStringPromise(
          nestedResponse.data
        );

        if (nestedParsed.urlset && nestedParsed.urlset.url) {
          const nestedUrls = nestedParsed.urlset.url.map(
            (entry) => entry.loc[0]
          );

          allUrls.push(...nestedUrls);
        }
      }

      return allUrls;
    }

    throw new Error("Unsupported sitemap structure");
  } catch (error) {
    console.error("Failed to fetch sitemap:");
    console.error(error.message);
    return [];
  }
}

// Clean filenames
function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*]+/g, "_");
}

// Extract category from URL
function categorizeUrl(url) {
  try {
    const parsed = new URL(url);

    const parts = parsed.pathname
      .split("/")
      .filter(Boolean);

    return parts[0] || "general";
  } catch {
    return "unknown";
  }
}

// Remove unwanted UI elements
async function cleanPage(page) {
  await page.evaluate(() => {
    const selectors = [
      ".scroll-nojump",
      "aside",
      "nav",
      "[data-testid='search']",
      ".appBarClassName",
    ];

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        el.remove();
      });
    });
  });
}

// Generate PDF
async function savePageAsPDF(page, url, outputPath) {
  try {
    console.log(`Opening: ${url}`);

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    await cleanPage(page);

    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "20px",
        bottom: "20px",
        left: "20px",
        right: "20px",
      },
    });

    console.log(`Saved: ${outputPath}`);
  } catch (error) {
    console.error(`Failed: ${url}`);
    console.error(error.message);
  }
}

// Main runner
async function run() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const urls = await fetchSitemap();

  if (!urls.length) {
    console.log("No URLs found.");
    return;
  }

  console.log(`Found ${urls.length} pages`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();

  await page.setViewport({
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
  });

  let counter = 1;

  for (const url of urls) {
    const category = categorizeUrl(url);

    const categoryDir = path.join(OUTPUT_DIR, category);

    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    const fileName = sanitizeFileName(
      `page_${counter}.pdf`
    );

    const outputPath = path.join(categoryDir, fileName);

    await savePageAsPDF(page, url, outputPath);

    counter++;
  }

  await browser.close();

  console.log("Done.");
}

run().catch(console.error);
