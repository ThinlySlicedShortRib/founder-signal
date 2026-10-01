import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (count, err) => count < 2 && (err as { status?: number }).status !== 401 },
  },
});
