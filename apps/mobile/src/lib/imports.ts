import type { ConfirmImportInput, HandlePlatform, ImportCandidate, ImportMethod } from "@fs/schema";
import { MAX_OPML_BYTES } from "@fs/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { api, ApiError, unwrap } from "./api";

/**
 * "Import what I already follow" (docs/imports/README.md): each import lists
 * what it found; nothing is added until the checklist is confirmed.
 */

const KEY = ["me", "imports"] as const;

/** Recent imports, and whether Connect YouTube is set up on this server. */
export function useImportOptions() {
  return useQuery({ queryKey: KEY, queryFn: async () => unwrap(api.me.imports.$get()) });
}

export function useImport(id: string) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: async () => (await unwrap(api.me.imports[":id"].$get({ param: { id } }))).import,
  });
}

export function useImportOpml() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { opml: string; filename?: string }) => (await unwrap(api.me.imports.opml.$post({ json: input }))).import,
    onSuccess: (view) => {
      qc.setQueryData([...KEY, view.id], view);
      void qc.invalidateQueries({ queryKey: KEY, exact: true });
    },
  });
}

export function useImportHandle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { platform: HandlePlatform; handle: string }) => (await unwrap(api.me.imports.handle.$post({ json: input }))).import,
    onSuccess: (view) => {
      qc.setQueryData([...KEY, view.id], view);
      void qc.invalidateQueries({ queryKey: KEY, exact: true });
    },
  });
}

export function useConfirmImport(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfirmImportInput) => unwrap(api.me.imports[":id"].confirm.$post({ param: { id }, json: input })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["me", "sources"] });
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/** Lets the user pick an OPML file and returns its text, or null if they cancelled. */
export async function pickOpmlFile(): Promise<{ text: string; name: string } | null> {
  // OPML has no registered type on iOS, so any file can be picked; the server checks it.
  const result = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false, base64: false });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  if ((asset.size ?? 0) > MAX_OPML_BYTES) throw new ApiError("VALIDATION_FAILED", "That file is over 2 MB", 0);
  const text = Platform.OS === "web" && asset.file ? await asset.file.text() : await new File(asset.uri).text();
  return { text, name: asset.name };
}

/** Where Google sends the browser back to: the import screen, in this build of the app. */
export function importReturnUrl(): string {
  return Linking.createURL("/sources/import");
}

export type YouTubeConnectResult = { importId: string } | { error: string } | null;

const CONNECT_ERRORS: Record<string, string> = {
  denied: "YouTube access wasn't granted, so nothing was imported.",
  expired: "That took too long. Try connecting again.",
  failed: "Google didn't let us read your subscriptions. Try again in a minute.",
};

export function connectErrorMessage(code: string | null | undefined): string | null {
  return code ? (CONNECT_ERRORS[code] ?? CONNECT_ERRORS.failed!) : null;
}

/**
 * Connect YouTube: the API makes a one-time Google consent URL; we open it
 * and Google sends the browser back to the API, which reads the
 * subscriptions and redirects to the app with `importId`. On the web the
 * whole page goes to Google and comes back to /sources/import (this
 * function doesn't return); natively an auth session returns the URL.
 */
export async function connectYouTube(): Promise<YouTubeConnectResult> {
  const returnTo = importReturnUrl();
  const { url } = await unwrap(api.me.connections.youtube.start.$post({ json: { returnTo } }));
  if (Platform.OS === "web") {
    window.location.assign(url);
    return new Promise(() => {});
  }
  const result = await WebBrowser.openAuthSessionAsync(url, returnTo);
  if (result.type !== "success") return null;
  const { queryParams } = Linking.parse(result.url);
  const importId = typeof queryParams?.importId === "string" ? queryParams.importId : null;
  if (importId) return { importId };
  return { error: connectErrorMessage(typeof queryParams?.importError === "string" ? queryParams.importError : "failed")! };
}

export const METHOD_LABEL: Record<ImportMethod, string> = {
  opml: "OPML file",
  youtube: "YouTube",
  substack: "Substack",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  newsletter: "Newsletters by email",
};

export const HANDLE_FORMS: Record<HandlePlatform, { label: string; placeholder: string; hint: string }> = {
  substack: { label: "Your Substack handle", placeholder: "@yourname", hint: "From your profile, substack.com/@yourname. Only subscriptions you show publicly can be imported." },
  bluesky: { label: "Your Bluesky handle", placeholder: "yourname.bsky.social", hint: "We list everyone you follow, and the websites they link to." },
  mastodon: { label: "Your Mastodon handle", placeholder: "@yourname@mastodon.social", hint: "Include your server. Some servers keep follows private." },
};

/** The checklist's second line for a candidate. */
export function candidateDetail(c: ImportCandidate): string {
  if (c.kind === "youtube_channel") return "YouTube channel";
  if (c.check === "site") return `${c.detail ?? c.url} · feed looked up when added`;
  return c.detail ?? "Feed";
}
