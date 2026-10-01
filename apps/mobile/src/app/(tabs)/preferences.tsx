import { router } from "expo-router";
import { useState } from "react";
import { Body, Button, Card, Divider, Heading, Row, Screen, Small } from "@/components/ui";
import { authClient } from "@/lib/auth";
import { API_URL, APP_VERSION } from "@/lib/config";
import { confirm } from "@/lib/confirm";
import { queryClient } from "@/lib/query";
import { useSources } from "@/lib/sources";

export default function Preferences() {
  const { data: session } = authClient.useSession();
  const sources = useSources();
  const [signingOut, setSigningOut] = useState(false);
  const count = sources.data?.length;

  async function signOut() {
    const ok = await confirm({ title: "Sign out?", message: "You can sign back in with a code at any time.", confirmLabel: "Sign out" });
    if (!ok) return;
    setSigningOut(true);
    await authClient.signOut();
    queryClient.clear();
  }

  return (
    <Screen>
      <Card>
        <Heading>Reading</Heading>
        <Row
          icon="library-outline"
          label="Sources"
          detail={count === undefined ? null : count ? `${count} source${count === 1 ? "" : "s"}` : "None yet"}
          onPress={() => router.push("/sources")}
          accessibilityHint="Add, pause or remove the sources your letters draw from"
        />
        <Divider />
        <Row icon="flag-outline" label="Goals and topics" detail="Coming soon" />
        <Divider />
        <Row icon="time-outline" label="Schedule" detail="Coming soon" />
      </Card>

      <Card>
        <Heading>Account</Heading>
        <Body>{session?.user.email}</Body>
        <Button title="Sign out" variant="secondary" onPress={signOut} loading={signingOut} />
      </Card>

      <Small style={{ textAlign: "center" }}>
        Founder Signal {APP_VERSION}
        {__DEV__ ? ` · ${API_URL}` : ""}
      </Small>
    </Screen>
  );
}
