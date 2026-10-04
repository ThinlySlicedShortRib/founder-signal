import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { type ErrorBoundaryProps, Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ONBOARDING_FONTS } from "@/components/onboarding/kit";
import { Body, Button, Screen, Title } from "@/components/ui";
import { authClient } from "@/lib/auth";
import { installGlobalErrorHandlers, reportError, setErrorContext } from "@/lib/error-reporting";
import { useProfile } from "@/lib/profile";
import { queryClient } from "@/lib/query";
import { serif, useColors } from "@/lib/theme";

installGlobalErrorHandlers();

/** Render errors anywhere below the root land here (and in CloudWatch). */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => reportError(error, { fatal: true }), [error]);
  return (
    <Screen edges="both">
      <Title>Something went wrong</Title>
      <Body muted>The problem has been reported. Try again, and if it keeps happening, restart the app.</Body>
      <Button title="Try again" onPress={retry} />
    </Screen>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AppStack />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function AppStack() {
  const c = useColors();
  const { data: session, isPending } = authClient.useSession();
  const pathname = usePathname();
  useEffect(() => setErrorContext(pathname), [pathname]);
  const signedIn = !!session;
  const profile = useProfile({ enabled: signedIn });
  // Text falls back to the system font if these fail; don't hold the app on them.
  const [fontsLoaded, fontError] = useFonts(ONBOARDING_FONTS);

  if (isPending || (signedIn && profile.isPending) || (!fontsLoaded && !fontError)) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.background }}>
        <ActivityIndicator color={c.textMuted} accessibilityLabel="Loading" />
      </View>
    );
  }

  // A new account goes through onboarding first. If the profile can't load
  // (offline), the app opens rather than trapping the user on a setup screen.
  const onboarded = !!profile.data?.onboardedAt || (profile.isError && !profile.data);
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.background },
          headerTintColor: c.accent,
          headerTitleStyle: { fontFamily: serif, color: c.text },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: c.background },
        }}
      >
        <Stack.Protected guard={signedIn && onboarded}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="sources/index" options={{ title: "Sources" }} />
          <Stack.Screen name="sources/add" options={{ title: "Add a source", presentation: "modal" }} />
          <Stack.Screen name="sources/[id]" options={{ title: "Source" }} />
        </Stack.Protected>
        <Stack.Protected guard={signedIn && !onboarded}>
          <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}
