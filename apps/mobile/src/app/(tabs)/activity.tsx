import { EmptyState, Screen } from "@/components/ui";

export default function Activity() {
  return (
    <Screen>
      <EmptyState
        icon="calendar-outline"
        title="Your reading, day by day"
        body="Once letters arrive, each day you read or review a piece fills in here. No streaks to keep up unless you want them."
      />
    </Screen>
  );
}
