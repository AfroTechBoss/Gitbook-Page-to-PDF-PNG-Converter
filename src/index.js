const puppeteer = require("puppeteer");
const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE_URL = "https://docs.ifalabs.com";
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;
const OUTPUT_DIR = path.join(__dirname, "../pdfs");

// Ignore broken SSL cert chain
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

// Fetch sitemap URLs
async function fetchSitemap() {
  try {
    console.log("Fetching sitemap...");

    const response = await axios.get(SITEMAP_URL, {
      httpsAgent,
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });

    const parsed = await xml2js.parseStringPromise(response.data);

    // Standard sitemap
    if (parsed.urlset && parsed.urlset.url) {
      return parsed.urlset.url.map((u) => u.loc[0]);
    }

    // Sitemap index
    if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
      let allUrls = [];

      const sitemapLinks = parsed.sitemapindex.sitemap.map(
        (s) => s.loc[0]
      );

      for (const sitemap of sitemapLinks) {
        console.log(`Fetching nested sitemap: ${sitemap}`);

        const nestedResponse = await axios.get(sitemap, {
          httpsAgent,
          timeout: 30000,
        });

        const nestedParsed = await xml2js.parseStringPromise(
          nestedResponse.data
        );

        if (
          nestedParsed.urlset &&
          nestedParsed.urlset.url
        ) {
          const urls = nestedParsed.urlset.url.map(
            (u) => u.loc[0]
          );

          allUrls.push(...urls);
        }
      }

      return allUrls;
    }

    console.log("Unsupported sitemap structure");
    return [];
  } catch (error) {
    console.error("Failed to fetch sitemap:");
    console.error(error.message);
    return [];
  }
}

// Create safe filenames
function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*]+/g, "_");
}

// Categorize URLs
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

// Remove unnecessary GitBook UI
async function cleanPage(page) {
  await page.evaluate(() => {
    const selectors = [
      "aside",
      "nav",
      "header",
      ".scroll-nojump",
      "[data-testid='search']",
      ".group.flex.flex-col.basis-full.bg-light",
    ];

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        el.remove();
      });
    });
  });
}

// Save page as PDF
async function savePageAsPDF(page, url, outputPath) {
  try {
    console.log(`Opening: ${url}`);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Give React/GitBook time to hydrate
    await new Promise((resolve) =>
      setTimeout(resolve, 5000)
    );

    // Detect application crash pages
    const html = await page.content();

    if (
      html.includes("Application error") ||
      html.includes("client-side exception")
    ) {
      console.log(`Skipping broken page: ${url}`);
      return;
    }

    // Wait for actual content
    await page.waitForSelector("main", {
      timeout: 30000,
    });

    // Remove UI junk
    await cleanPage(page);

    // Export PDF
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
    console.error(`Failed page: ${url}`);
    console.error(error.message);
  }
}

// Main runner
async function run() {
  // Create output dir
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, {
      recursive: true,
    });
  }

  // Fetch URLs
  const urls = await fetchSitemap();

  if (!urls.length) {
    console.log("No URLs found.");
    return;
  }

  console.log(`Found ${urls.length} URLs`);

  // Launch browser
  const browser = await puppeteer.launch({
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--allow-running-insecure-content",
    ],
  });

  const page = await browser.newPage();

  // Real browser fingerprint
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  await page.setViewport({
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
  });

  let counter = 1;

  // Process URLs
  for (const url of urls) {
    const category = categorizeUrl(url);

    const categoryDir = path.join(
      OUTPUT_DIR,
      category
    );

    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, {
        recursive: true,
      });
    }

    const fileName = sanitizeFileName(
      `page_${counter}.pdf`
    );

    const outputPath = path.join(
      categoryDir,
      fileName
    );

    await savePageAsPDF(
      page,
      url,
      outputPath
    );

    counter++;
  }

  await browser.close();

  console.log("Finished.");
}

run().catch(console.error);
