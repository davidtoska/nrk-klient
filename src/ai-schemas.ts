import * as z from "zod";
import type {
    GetEpisodesInput,
    GetProgramsInput,
    GetSeriesInput,
    SearchCatalogInput,
} from "./ai-types";

/**
 * Input schemas for AiClient. They double as
 *  - runtime validation of whatever an agent sends, and
 *  - the source of a JSON Schema for the model: z.toJSONSchema(schema, { io: "input" }),
 * so the description strings are written for the model.
 */

export const searchCatalogInput = z.object({
    query: z
        .string()
        .max(200)
        .optional()
        .describe(
            "Keywords, separated by space or comma, matched against title and description " +
                "(substring match, case-insensitive). By default an item matches if ANY keyword " +
                "matches, and items matching more keywords / in the title rank first. " +
                "Use several related words (e.g. 'fotball, vm, landslag') for a theme. " +
                "Omit to browse the whole catalog alphabetically.",
        ),
    type: z
        .enum(["program", "series", "any"])
        .default("any")
        .describe(
            "'program' = a single program (film, documentary, one-off), " +
                "'series' = a series with episodes, 'any' = both.",
        ),
    matchAll: z
        .boolean()
        .default(false)
        .describe("Require ALL keywords to match instead of any."),
    onDemandOnly: z
        .boolean()
        .default(true)
        .describe("Only items that can currently be streamed on demand."),
    includeGeoBlocked: z
        .boolean()
        .default(false)
        .describe("Include items that are geoblocked outside Norway."),
    descriptionMaxChars: z
        .number()
        .int()
        .min(20)
        .max(5000)
        .optional()
        .describe(
            "Shorten each description to this many characters to save tokens. " +
                "Omit to get the full text (median ~100 characters, at most ~800).",
        ),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
});

export const getSeriesInput = z.object({
    seriesId: z
        .string()
        .min(1)
        .max(200)
        .describe("Series id from searchCatalog, e.g. 'dagsrevyen'."),
});

export const getEpisodesInput = z.object({
    seriesId: z.string().min(1).max(200),
    seasonName: z
        .string()
        .min(1)
        .max(200)
        .describe("A season 'name' from getSeries (e.g. '2023', 'latest')."),
    availableOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
        .optional()
        .describe(
            "Only episodes that can be streamed on this date (YYYY-MM-DD). " +
                "Use the broadcast date of the schedule you are building.",
        ),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
});

export const getProgramsInput = z.object({
    programIds: z
        .array(z.string().min(1).max(50))
        .min(1)
        .max(20)
        .describe(
            "Program ids (episode ids from getEpisodes, or program ids from searchCatalog), max 20.",
        ),
});

/**
 * The public input interfaces (ai-types.ts) are written by hand so that no zod types
 * appear in the published declarations. These checks make the build fail if a schema
 * and its interface drift apart.
 */
type Accepts<Schema extends z.ZodType, Input> = Input extends z.input<Schema> ? true : never;
export const _inputsMatchSchemas: [
    Accepts<typeof searchCatalogInput, SearchCatalogInput>,
    Accepts<typeof getSeriesInput, GetSeriesInput>,
    Accepts<typeof getEpisodesInput, GetEpisodesInput>,
    Accepts<typeof getProgramsInput, GetProgramsInput>,
] = [true, true, true, true];
