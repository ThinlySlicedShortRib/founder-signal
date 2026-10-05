import { router, useLocalSearchParams } from "expo-router";
import { ImportChecklist } from "@/components/imports/ImportChecklist";

/** The checklist for one import. Done goes back to Sources, which has refreshed. */
export default function ImportReview() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ImportChecklist
      importId={id}
      onDone={() => (router.canDismiss() ? router.dismissTo("/sources") : router.replace("/sources"))}
    />
  );
}
