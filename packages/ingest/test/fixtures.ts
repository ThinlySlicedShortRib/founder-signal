/** Deterministic filler prose, so word counts are predictable. */
export function prose(sentences: number, seed = 0): string {
  const words = [
    "founders", "pricing", "customers", "retention", "service", "product", "market", "revenue", "hiring", "margins",
    "distribution", "churn", "onboarding", "positioning", "consulting", "packaging", "sales", "trust", "cash", "focus",
  ];
  const out: string[] = [];
  for (let s = 0; s < sentences; s++) {
    const sentence: string[] = [];
    for (let w = 0; w < 12; w++) sentence.push(words[(s * 7 + w * 3 + seed) % words.length]!);
    out.push(`${sentence.join(" ")}.`);
  }
  return out.join(" ");
}

export function articleHtml({
  title = "Moving from consulting to a productized service",
  paragraphs = 12,
  extraHead = "",
  extraBody = "",
  seed = 0,
} = {}) {
  const body = Array.from({ length: paragraphs }, (_, i) => `<p>${prose(3, seed + i)}</p>`);
  return `<!doctype html>
<html lang="en-GB">
<head>
  <title>${title} | Example Blog</title>
  <meta property="og:title" content="${title}">
  <meta property="og:site_name" content="Example Blog">
  <meta property="og:type" content="article">
  <meta name="author" content="Ada Founder">
  <meta property="article:published_time" content="2026-09-01T09:00:00Z">
  <link rel="canonical" href="/posts/productized-service">
  <link rel="alternate" type="application/rss+xml" title="Example Blog" href="/feed.xml">
  <link rel="alternate" type="application/rss+xml" title="Comments Feed" href="/comments/feed.xml">
  ${extraHead}
</head>
<body>
  <nav><a href="/">Home</a> <a href="/about">About</a></nav>
  <article>
    <h1>${title}</h1>
    ${body.slice(0, paragraphs / 2).join("\n")}
    <h2>Pricing the first package</h2>
    ${body.slice(paragraphs / 2).join("\n")}
    <figure><img src="/img/chart.png" alt="Revenue chart"><figcaption>Revenue after the switch</figcaption></figure>
    <ul><li>Fixed scope</li><li>Fixed price</li></ul>
    <blockquote>Sell the outcome, not the hours.</blockquote>
    <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Starter</td><td>$2,000</td></tr></table>
    ${extraBody}
  </article>
  <footer>© Example Blog</footer>
  <script>window.tracking = true;</script>
</body>
</html>`;
}

export const paywalledHtml = articleHtml({
  title: "The subscriber-only playbook",
  paragraphs: 2,
  extraHead: `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: "The subscriber-only playbook",
    isAccessibleForFree: false,
    hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".paywall" },
  })}</script>`,
  extraBody: `<div class="paywall">Subscribe to keep reading.</div>`,
});

export const rssFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com/</link>
    <atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml"/>
    <item>
      <title>Moving from consulting &amp; services</title>
      <link>https://example.com/posts/productized-service?utm_source=rss</link>
      <dc:creator>Ada Founder</dc:creator>
      <pubDate>Tue, 01 Sep 2026 09:00:00 GMT</pubDate>
      <guid isPermaLink="false">post-1</guid>
    </item>
    <item>
      <title>Relative link post</title>
      <link>/posts/relative</link>
      <pubDate>not a date</pubDate>
    </item>
    <item>
      <title>No link at all</title>
    </item>
  </channel>
</rss>`;

export const atomFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Site</title>
  <link href="https://atom.example.org/feed.atom" rel="self"/>
  <link href="https://atom.example.org/" rel="alternate"/>
  <entry>
    <title type="html">Hiring your first salesperson</title>
    <link href="https://atom.example.org/2026/hiring" rel="alternate"/>
    <id>urn:uuid:1</id>
    <published>2026-08-20T10:00:00Z</published>
    <author><name>Bo Builder</name></author>
  </entry>
</feed>`;

export const rdfFeed = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example.net/">
    <title>RDF Site</title>
    <link>https://rdf.example.net/</link>
  </channel>
  <item rdf:about="https://rdf.example.net/one">
    <title>One</title>
    <link>https://rdf.example.net/one</link>
    <dc:date>2026-07-01T00:00:00Z</dc:date>
  </item>
</rdf:RDF>`;
