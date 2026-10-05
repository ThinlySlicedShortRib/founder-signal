import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { KeyboardAvoidingView, Platform } from "react-native";
import { ImportOptions } from "@/components/imports/ImportOptions";
import { palette } from "@/components/onboarding/kit";
import { Body, Screen } from "@/components/ui";
import { connectErrorMessage } from "@/lib/imports";

/**
 * Import what you follow. Also where Connect YouTube comes back to on the
 * web (`?importId=` or `?importError=`): an import goes straight to its checklist.
 */
export default function ImportSources() {
  const { importId, importError } = useLocalSearchParams<{ importId?: string; importError?: string }>();

  useEffect(() => {
    if (importId) router.replace({ pathname: "/sources/import/[id]", params: { id: importId } });
  }, [importId]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: palette.ground }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen>
        <Body muted>Bring the newsletters, blogs, channels and people you already follow, so your letters start from what you trust.</Body>
        <ImportOptions
          initialError={connectErrorMessage(importError)}
          onImported={(id) => router.push({ pathname: "/sources/import/[id]", params: { id } })}
        />
      </Screen>
    </KeyboardAvoidingView>
  );
}
