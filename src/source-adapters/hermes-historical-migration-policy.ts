import type { NormalizedExperience } from "./contracts.js";
import { TextualExperienceMigrationEligibilityPolicy } from "./historical-migration-runner.js";
import type {
  HistoricalMigrationEligibilityDecision,
  HistoricalMigrationEligibilityPolicy,
} from "./source-migration.js";

/**
 * Hermes-specific historical migration policy.
 *
 * This policy is intentionally outside HermesSourceAdapter: adapters translate
 * source evidence, while migration policy decides which normalized experiences
 * are eligible to enter Memory Intelligence.
 */
export class HermesHistoricalMigrationEligibilityPolicy
  implements HistoricalMigrationEligibilityPolicy
{
  readonly version = "hermes-historical-v1";
  readonly #textual = new TextualExperienceMigrationEligibilityPolicy();

  assess(experience: NormalizedExperience): HistoricalMigrationEligibilityDecision {
    if (experience.sourceSystem !== "hermes" || experience.sourceType !== "conversation_session") {
      throw new Error("Hermes historical migration policy received a foreign NormalizedExperience");
    }
    if (experience.metadata.hidden === true) {
      return { eligible: false, reasonCode: "hermes_hidden_session" };
    }
    const messageCount = Number(experience.metadata.messageCount ?? NaN);
    if (Number.isFinite(messageCount) && messageCount <= 0) {
      return { eligible: false, reasonCode: "hermes_empty_session" };
    }
    const textual = this.#textual.assess(experience);
    return textual.eligible
      ? { eligible: true, reasonCode: "hermes_textual_evidence" }
      : { eligible: false, reasonCode: textual.reasonCode };
  }
}
