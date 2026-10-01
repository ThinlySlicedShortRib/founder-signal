// Lambda: founder-signal-<env>-sweep. EventBridge Scheduler, every 5 minutes.
import { lambdaDeps } from "../lib/lambda.ts";
import { sweep } from "../pipeline/sweep.ts";

export async function handler() {
  return sweep(await lambdaDeps());
}
