import { EmptyState, Screen } from "@/components/ui";

export default function Library() {
  return (
    <Screen>
      <EmptyState
        icon="bookmarks-outline"
        title="Nothing saved yet"
        body="Pieces you save from your letters, and every letter you've received, will be here, searchable and readable offline."
      />
    </Screen>
  );
}
