import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanSubject,
  decodeTrackedLink,
  detectForwardingConfirmation,
  findWebVersionUrl,
  INBOUND_LOCAL_PART,
  inboundLocalPartOf,
  InboundEmailError,
  memoryRawMailStore,
  newInboundLocalPart,
  newsletterSender,
  newsletterToArticle,
  parseInboundEmail,
  syntheticNewsletterUrl,
  unwrapManualForward,
} from "../src/index.ts";
import { prose } from "./fixtures.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "newsletters");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.eml`));
const MAX = 5 * 1024 * 1024;

/** A minimal message: headers, a blank line, a body. */
function eml({ headers = {}, html, text }: { headers?: Record<string, string>; html?: string; text?: string }) {
  const h = { From: "Writer <writer@example.org>", To: "n-abcdefghijkl@in.example.com", Subject: "A test issue", Date: "Mon, 05 Oct 2026 08:00:00 +0000", "Message-ID": "<t1@example.org>", "MIME-Version": "1.0", ...headers };
  const head = Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n");
  if (html && text) {
    return `${head}\r\nContent-Type: multipart/alternative; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--b--\r\n`;
  }
  return `${head}\r\nContent-Type: ${html ? "text/html" : "text/plain"}; charset=utf-8\r\n\r\n${html ?? text ?? ""}\r\n`;
}

describe("parseInboundEmail", () => {
  it("reads a Substack post: sender, list, date and both bodies", async () => {
    const email = await parseInboundEmail(fixture("substack-post"), { maxBytes: MAX });
    expect(email.subject).toBe("Pricing your first productized service");
    expect(email.from).toEqual({ name: "The Bootstrapped Operator", address: "thebootstrappedoperator@substack.com" });
    expect(email.listId).toEqual({ id: "thebootstrappedoperator.substack.com", name: "The Bootstrapped Operator" });
    expect(email.date?.toISOString()).toBe("2026-10-05T08:02:00.000Z");
    expect(email.messageId).toBe("<20261005080200.3.a1b2c3d4e5f6@mg1.substack.com>");
    expect(email.html).toContain("Write the promise before the price");
    expect(email.text).toContain("View this post on the web at");
    // Filter-forwarded: the original To (the user's own mailbox) and the Received "for".
    expect(email.recipients).toEqual(["sam.reader@example.com"]);
  });

  it("decodes a Beehiiv issue's encoded subject and quoted-printable HTML", async () => {
    const email = await parseInboundEmail(fixture("beehiiv-newsletter"), { maxBytes: MAX });
    expect(email.subject).toBe("Three hiring mistakes we keep seeing 👀");
    expect(email.from).toEqual({ name: "Jordan at Founder Ops Weekly", address: "hello@mail.founderopsweekly.com" });
    expect(email.listId).toBeNull();
    expect(email.html).toContain('style="font-size:30px;margin:0;">Three hiring mistakes we keep seeing</h1>');
  });

  it("reads a plain-text-only message", async () => {
    const email = await parseInboundEmail(eml({ text: `Hello.\r\n\r\n${prose(3)}` }), { maxBytes: MAX });
    expect(email.html).toBeNull();
    expect(email.text).toContain("Hello.");
  });

  it("refuses a message over the size cap before parsing it", async () => {
    const huge = eml({ text: "x".repeat(6 * 1024 * 1024) });
    await expect(parseInboundEmail(huge, { maxBytes: MAX })).rejects.toMatchObject({ reason: "too_large" });
  });

  it("refuses input that isn't an email", async () => {
    const err = await parseInboundEmail(new Uint8Array([0, 159, 146, 150, 0, 0, 1]), { maxBytes: MAX }).catch((e) => e);
    expect(err).toBeInstanceOf(InboundEmailError);
    expect(err.reason).toBe("malformed");
  });

  it("collects forwarding headers first, and trusts only SES's own verdict headers on top", async () => {
    const email = await parseInboundEmail(
      eml({
        headers: {
          "X-SES-Spam-Verdict": "FAIL",
          "X-SES-Virus-Verdict": "PASS",
          "Authentication-Results": "amazonses.com; spf=pass (spf: …) smtp.mailfrom=example.org; dkim=fail header.i=@example.org; dmarc=none header.from=example.org",
          "X-Forwarded-To": "n-zzzzzzzzzzzz@in.example.com",
          "X-Spam-Note": "x",
        },
        text: prose(2),
      }),
      { maxBytes: MAX },
    );
    expect(email.headerVerdicts).toEqual({ spam: "FAIL", virus: "PASS", spf: "PASS", dkim: "FAIL", dmarc: "GRAY" });
    expect(email.recipients[0]).toBe("n-zzzzzzzzzzzz@in.example.com");
  });
});

describe("inbound addresses", () => {
  it("makes unguessable n-<12 base32> local parts", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newInboundLocalPart()));
    expect(seen.size).toBe(200);
    for (const l of seen) expect(l).toMatch(INBOUND_LOCAL_PART);
  });

  it("recognizes our addresses only on our domain, ignoring case and +tags", () => {
    expect(inboundLocalPartOf("N-ABCDEFGHIJKL@In.Example.com", "in.example.com")).toBe("n-abcdefghijkl");
    expect(inboundLocalPartOf("<n-abcdefghijkl+gmail@in.example.com>", "in.example.com")).toBe("n-abcdefghijkl");
    expect(inboundLocalPartOf("n-abcdefghijkl@other.com", "in.example.com")).toBeNull();
    expect(inboundLocalPartOf("admin@in.example.com", "in.example.com")).toBeNull();
    expect(inboundLocalPartOf("n-short@in.example.com", "in.example.com")).toBeNull();
  });
});

describe("detectForwardingConfirmation", () => {
  it("reads Gmail's code, link and the asking mailbox", async () => {
    const email = await parseInboundEmail(fixture("gmail-forwarding-confirmation"), { maxBytes: MAX });
    expect(detectForwardingConfirmation(email)).toEqual({
      provider: "gmail",
      code: "284716395",
      url: "https://mail-settings.google.com/mail/vf-%5BANGjdJ8x1Qe7example%5D-Zm9yd2FyZGluZ2NvbmZpcm1hdGlvbg",
      requestedBy: "sam.reader@example.com",
    });
  });

  it("ignores look-alikes: wrong sender, failed DKIM, links off Google's hosts", async () => {
    const gmail = await parseInboundEmail(fixture("gmail-forwarding-confirmation"), { maxBytes: MAX });
    expect(detectForwardingConfirmation({ ...gmail, from: { name: "Gmail", address: "forwarding-noreply@goog1e.com" } })).toBeNull();
    expect(detectForwardingConfirmation(gmail, { dkim: "FAIL" })).toBeNull();
    const phish = detectForwardingConfirmation({ ...gmail, text: "Confirmation code: 111222333\nhttps://evil.example/mail/vf-abc" });
    expect(phish).toMatchObject({ code: "284716395", url: null });
  });

  it("recognizes an Outlook forwarding verification, best effort", () => {
    const found = detectForwardingConfirmation({
      from: { name: "Microsoft account team", address: "account-security-noreply@accountprotection.microsoft.com" },
      subject: "Verify your forwarding address",
      text: "To finish setting up forwarding for sam@outlook.com, use security code 5521 or https://account.live.com/confirm?x=1",
      html: null,
    });
    expect(found).toEqual({ provider: "outlook", code: "5521", url: "https://account.live.com/confirm?x=1", requestedBy: "sam@outlook.com" });
  });

  it("doesn't treat a newsletter as a confirmation", async () => {
    expect(detectForwardingConfirmation(await parseInboundEmail(fixture("substack-post"), { maxBytes: MAX }))).toBeNull();
  });
});

describe("unwrapManualForward", () => {
  const original = prose(4);
  it("reads Gmail's forwarded header block and quoted original", () => {
    const out = unwrapManualForward({
      subject: "Fwd: The pricing issue",
      text: `Thought you'd like this\r\n\r\n---------- Forwarded message ---------\r\nFrom: Pricing Weekly <hello@pricingweekly.com>\r\nDate: Mon, Oct 5, 2026 at 9:02 AM\r\nSubject: The pricing issue\r\nTo: <sam.reader@example.com>\r\n\r\n${original}`,
      html: `<div>Thought you'd like this</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Pricing Weekly</div><div><p>${original}</p></div></div>`,
    });
    expect(out?.from).toEqual({ name: "Pricing Weekly", address: "hello@pricingweekly.com" });
    expect(out?.subject).toBe("The pricing issue");
    expect(out?.date?.getFullYear()).toBe(2026);
    expect(out?.text).toBe(original);
    expect(out?.html).toContain(original);
    expect(out?.html).not.toContain("Forwarded message");
  });

  it("reads Outlook's block (Sent, [mailto:])", () => {
    const out = unwrapManualForward({
      subject: "FW: Ops notes",
      text: `\r\n________________________________\r\nFrom: Ops Notes <notes@opsnotes.io>\r\nSent: Monday, October 5, 2026 9:02 AM\r\nTo: Sam\r\nSubject: Ops notes\r\n\r\n${original}`,
      html: null,
    });
    expect(out?.from?.address).toBe("notes@opsnotes.io");
    expect(out?.subject).toBe("Ops notes");
  });

  it("leaves mail that isn't a manual forward alone", () => {
    expect(unwrapManualForward({ subject: "The pricing issue", text: original, html: null })).toBeNull();
    expect(unwrapManualForward({ subject: "Fwd: no block here", text: original, html: null })).toBeNull();
  });
});

describe("newsletterSender", () => {
  it("keys a Substack publication by its host, like its RSS feed", () => {
    expect(
      newsletterSender({
        from: { name: "The Bootstrapped Operator", address: "thebootstrappedoperator@substack.com" },
        listId: { id: "thebootstrappedoperator.substack.com", name: "The Bootstrapped Operator" },
        webUrl: "https://thebootstrappedoperator.substack.com/p/pricing",
      }),
    ).toEqual({
      key: "list:thebootstrappedoperator.substack.com",
      label: "thebootstrappedoperator@substack.com",
      title: "The Bootstrapped Operator",
      author: null,
      publisher: { key: "thebootstrappedoperator.substack.com", name: "The Bootstrapped Operator" },
    });
  });

  it("uses a custom domain web version over the List-Id", () => {
    const s = newsletterSender({ from: { name: "Lenny", address: "lenny@substack.com" }, listId: { id: "lenny.substack.com", name: "Lenny's Newsletter" }, webUrl: "https://www.lennysnewsletter.com/p/x" });
    expect(s.publisher.key).toBe("lennysnewsletter.com");
    expect(s.title).toBe("Lenny's Newsletter");
  });

  it("strips mail subdomains and splits 'Name at Publication'", () => {
    const s = newsletterSender({ from: { name: "Jordan at Founder Ops Weekly", address: "hello@mail.founderopsweekly.com" }, listId: null, webUrl: null });
    expect(s).toMatchObject({ key: "from:hello@mail.founderopsweekly.com", title: "Founder Ops Weekly", author: "Jordan", publisher: { key: "founderopsweekly.com" } });
  });

  it("keys platform senders with nothing else by their address", () => {
    expect(newsletterSender({ from: { name: null, address: "someone@gmail.com" }, listId: null, webUrl: null }).publisher.key).toBe("email:someone@gmail.com");
  });

  it("cleans forwarded subjects", () => {
    expect(cleanSubject("Fwd: RE: Fw:  The   issue ")).toBe("The issue");
  });
});

describe("newsletterToArticle", () => {
  it("extracts the Substack post's body, without chrome, buttons, footer or pixels", async () => {
    const email = await parseInboundEmail(fixture("substack-post"), { maxBytes: MAX });
    const a = newsletterToArticle({ html: email.html, text: email.text, title: email.subject });
    const text = a.text;
    expect(a.tooShort).toBe(false);
    expect(a.blocks.find((b) => b.type === "heading" && b.level === 2)).toEqual({ type: "heading", level: 2, text: "Write the promise before the price" });
    expect(a.blocks.some((b) => b.type === "quote")).toBe(true);
    expect(a.blocks.find((b) => b.type === "list")).toMatchObject({ items: expect.arrayContaining(["What you never deliver"]) });
    expect(text).toContain("Most consultants who turn their work into a product");
    for (const chrome of ["Unsubscribe", "Get the app", "Restack", "Forwarded this email", "© 2026", "Three steps from day rates to a price customers understand&"]) {
      expect(text).not.toContain(chrome);
    }
    // The hidden preheader and the title (shown by the reader) aren't body text.
    expect(a.blocks[0]).not.toEqual(expect.objectContaining({ text: "Pricing your first productized service" }));
    const images = a.blocks.filter((b) => b.type === "image");
    expect(images).toEqual([expect.objectContaining({ src: "https://substack-post-media.example/public/images/pricing-ladder.png", caption: "From day rates to a monthly plan." })]);
    expect(a.leadImageUrl).toBe("https://substack-post-media.example/public/images/pricing-ladder.png");
    expect(a.excerpt).toBeTruthy();
    expect(a.simhash).not.toBeNull();
  });

  it("unwraps Beehiiv's layout tables into headings and paragraphs, dropping the masthead logo", async () => {
    const email = await parseInboundEmail(fixture("beehiiv-newsletter"), { maxBytes: MAX });
    const a = newsletterToArticle({ html: email.html, text: email.text, title: cleanSubject(email.subject) });
    expect(a.blocks.some((b) => b.type === "table")).toBe(false);
    expect(a.blocks.filter((b) => b.type === "heading").map((b) => (b as { text: string }).text)).toEqual([
      "Hire for the job you have next quarter",
      "Stop running interviews without a scorecard",
      "Your first operations hire is not an assistant",
    ]);
    expect(a.blocks.some((b) => b.type === "image")).toBe(false);
    expect(a.text).not.toMatch(/Read Online|unsubscribe|Powered by beehiiv|Subscribe here/i);
  });

  it("keeps a real data table", () => {
    const html = `<p>${prose(3)}</p><table><tr><th>Plan</th><th>Price</th></tr><tr><td>Starter</td><td>$49</td></tr><tr><td>Pro</td><td>$99</td></tr></table>`;
    expect(newsletterToArticle({ html, text: null, title: null }).blocks).toContainEqual({ type: "table", header: ["Plan", "Price"], rows: [["Starter", "$49"], ["Pro", "$99"]] });
  });

  it("removes anything executable or hidden, and tracking pixels", () => {
    const html = `<html><head><script>steal()</script><style>p{color:red}</style></head><body>
      <div style="display:none">hidden preheader text</div>
      <p onclick="steal()">${prose(3)}</p>
      <script>document.cookie</script><iframe src="https://evil.example"></iframe><form><input value="x"><button>Go</button></form>
      <svg><script>alert(1)</script></svg><object data="x.swf"></object>
      <a href="javascript:alert(1)">click me for more of the story here</a>
      <img src="https://t.example/open/abc" width="1" height="1"><img src="https://cdn.example/spacer.gif"><img src="javascript:alert(1)">
      <img src="data:image/png;base64,AAAA"><img src="https://cdn.example/chart.png" width="600" alt="A chart">
    </body></html>`;
    const a = newsletterToArticle({ html, text: null, title: null });
    const json = JSON.stringify(a.blocks);
    expect(json).not.toMatch(/steal|cookie|alert|evil|hidden preheader|color:red|javascript|swf|data:image|spacer|t\.example/);
    expect(a.blocks.filter((b) => b.type === "image")).toEqual([{ type: "image", src: "https://cdn.example/chart.png", alt: "A chart" }]);
    // Blocks only have the known shapes.
    for (const b of a.blocks) expect(["heading", "paragraph", "quote", "list", "image", "caption", "table"]).toContain(b.type);
  });

  it("turns a plain-text newsletter into paragraphs and lists", () => {
    const a = newsletterToArticle({ html: null, text: `${prose(2)}\n\n- one point\n- another point\n\n${prose(2, 3)}\n\nUnsubscribe: https://x.example/u`, title: null });
    expect(a.blocks.map((b) => b.type)).toEqual(["paragraph", "list", "paragraph"]);
  });

  it("flags a message with almost no text", () => {
    expect(newsletterToArticle({ html: "<p>See you next week!</p>", text: null, title: null })).toMatchObject({ tooShort: true, blocks: [], simhash: null });
  });
});

describe("links", () => {
  it("decodes trackers that carry their target, and leaves opaque ones", () => {
    expect(decodeTrackedLink("https://www.google.com/url?q=https://example.com/post&sa=D")).toBe("https://example.com/post");
    const b64 = Buffer.from("https://blog.example.com/p/hello?x=1").toString("base64url");
    expect(decodeTrackedLink(`https://click.convertkit-mail2.com/abc123/xyz/${b64}`)).toBe("https://blog.example.com/p/hello?x=1");
    expect(decodeTrackedLink("https://link.mail.beehiiv.com/ss/c/u001.opaque/4bk/abc")).toBe("https://link.mail.beehiiv.com/ss/c/u001.opaque/4bk/abc");
  });

  it("finds the Substack post's web version, canonicalized", async () => {
    const email = await parseInboundEmail(fixture("substack-post"), { maxBytes: MAX });
    expect(findWebVersionUrl({ html: email.html, text: email.text, listPost: email.listPost, title: email.subject })).toBe(
      "https://thebootstrappedoperator.substack.com/p/pricing-your-first-productized-service",
    );
    // From the HTML alone: the title's link.
    expect(findWebVersionUrl({ html: email.html, text: null, listPost: null, title: email.subject })).toBe(
      "https://thebootstrappedoperator.substack.com/p/pricing-your-first-productized-service",
    );
  });

  it("has none when the only links are opaque trackers (Beehiiv fixture)", async () => {
    const email = await parseInboundEmail(fixture("beehiiv-newsletter"), { maxBytes: MAX });
    expect(findWebVersionUrl({ html: email.html, text: email.text, listPost: email.listPost, title: cleanSubject(email.subject) })).toBeNull();
  });

  it("uses a decodable 'View in browser' link, and List-Post when it's a web URL", () => {
    const target = Buffer.from("https://news.example.com/issues/42?utm_source=email").toString("base64url");
    expect(findWebVersionUrl({ html: `<a href="https://click.example-mail.com/x/${target}">View in browser</a>`, text: null, listPost: null, title: null })).toBe("https://news.example.com/issues/42");
    expect(findWebVersionUrl({ html: null, text: null, listPost: "https://news.example.com/p/hello", title: null })).toBe("https://news.example.com/p/hello");
    expect(findWebVersionUrl({ html: `<a href="https://open.substack.com/pub/acme/p/launch?r=1">Launch</a>`, text: null, listPost: null, title: "Launch" })).toBe("https://acme.substack.com/p/launch");
  });

  it("makes a stable synthetic key per message", () => {
    const a = syntheticNewsletterUrl({ messageId: "<m1@x>", from: null, subject: null, date: null, text: "" });
    expect(a).toMatch(/^newsletter:\/\/[0-9a-f]{40}$/);
    expect(syntheticNewsletterUrl({ messageId: "<m1@x>", from: "y", subject: "z", date: null, text: "w" })).toBe(a);
  });
});

describe("memoryRawMailStore", () => {
  it("stores, caps reads by size, and deletes", async () => {
    const { store } = memoryRawMailStore();
    await store.put("inbound/a", new Uint8Array(10));
    expect(await store.get("inbound/a", { maxBytes: 5 })).toBe("tooLarge");
    expect((await store.get("inbound/a", { maxBytes: 50 })) as Uint8Array).toHaveLength(10);
    await store.delete("inbound/a");
    expect(await store.get("inbound/a", { maxBytes: 50 })).toBeNull();
  });
});
