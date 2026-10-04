import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";
import { Body, Button, Card, Screen, Small, space, TextField, Title } from "@/components/ui";
import { font, palette } from "@/components/onboarding/kit";
import { authClient } from "@/lib/auth";
import { API_URL } from "@/lib/config";
import { queryClient } from "@/lib/query";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignIn() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode() {
    const address = email.trim().toLowerCase();
    if (!EMAIL.test(address)) return setError("Enter your email address");
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.emailOtp.sendVerificationOtp({ email: address, type: "sign-in" });
    setBusy(false);
    if (err) return setError(err.message ?? "We couldn't send a code. Try again.");
    setEmail(address);
    setCode("");
    setStep("code");
  }

  async function verify(value = code) {
    if (!/^\d{6}$/.test(value)) return setError("Enter the 6-digit code");
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.signIn.emailOtp({ email, otp: value });
    setBusy(false);
    if (err) return setError(err.status === 400 || err.status === 401 ? "That code didn't work. Check it or send a new one." : (err.message ?? "Sign-in failed"));
    // Start the signed-in app with a clean cache.
    queryClient.clear();
  }

  /** Development only: the local API hands back a code for the dev account. */
  async function skipSignIn() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/dev/sign-in-code`, { method: "POST" });
      if (!res.ok) throw new Error(res.status === 404 ? "Dev sign-in only works against a local API" : `Dev sign-in failed (${res.status})`);
      const { email: devEmail, otp } = (await res.json()) as { email: string; otp: string };
      const { error: err } = await authClient.signIn.emailOtp({ email: devEmail, otp });
      if (err) throw new Error(err.message ?? "Dev sign-in failed");
      queryClient.clear();
    } catch (err) {
      setError(err instanceof TypeError ? `Can't reach the API at ${API_URL}` : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: palette.ground }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen edges="both">
        <View style={{ gap: space.sm, marginTop: space.xxl }}>
          <Title style={{ fontSize: 34, lineHeight: 40 }}>Founder Signal</Title>
          <Body muted>A short letter of the pieces most worth your time, from the sources you trust and a few new ones.</Body>
        </View>

        <Card style={{ gap: space.lg }}>
          {step === "email" ? (
            <>
              <TextField
                label="Email"
                value={email}
                onChangeText={(v) => {
                  setEmail(v);
                  setError(null);
                }}
                placeholder="you@example.com"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                returnKeyType="send"
                onSubmitEditing={sendCode}
                error={error}
                autoFocus
              />
              <Button title="Email me a sign-in code" onPress={sendCode} loading={busy} />
              <Small>No password. We’ll send a 6-digit code that works for 10 minutes.</Small>
            </>
          ) : (
            <>
              <Body>
                We sent a code to <Text style={{ fontFamily: font.bodySemi }}>{email}</Text>.
              </Body>
              <TextField
                label="Sign-in code"
                value={code}
                onChangeText={(v) => {
                  const digits = v.replace(/\D/g, "").slice(0, 6);
                  setCode(digits);
                  setError(null);
                  if (digits.length === 6) void verify(digits);
                }}
                placeholder="123456"
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={6}
                style={{ fontSize: 24, letterSpacing: 8 }}
                error={error}
                hint={__DEV__ ? "Developing locally? The code is printed in the API's log." : undefined}
                autoFocus
              />
              <Button title="Sign in" onPress={() => verify()} loading={busy} />
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <TextLink label="Use a different email" onPress={() => setStep("email")} />
                <TextLink label="Send a new code" onPress={sendCode} />
              </View>
            </>
          )}
        </Card>

        {__DEV__ && (
          <View style={{ gap: space.sm }}>
            <Button title="Skip sign-in (dev)" variant="secondary" icon="flash-outline" onPress={skipSignIn} loading={busy} />
            <Small style={{ textAlign: "center" }}>Signs in as dev@founder-signal.local. Only in development builds against a local API.</Small>
          </View>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}

function TextLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={{ minHeight: 44, justifyContent: "center" }}>
      <Text style={{ color: palette.blue, fontFamily: font.bodySemi }}>{label}</Text>
    </Pressable>
  );
}
