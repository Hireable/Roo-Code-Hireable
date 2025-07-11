import * as fs from "fs/promises"
import * as path from "path"
import { EOL } from "os"

/**
 * @file This script processes conversation logs generated by ConversationLogger.ts
 * and transforms them into a supervised fine-tuning (SFT) dataset format.
 * It supports both Google Gemini and OpenAI formats.
 *
 * It can be run with --gemini (default) or --openai flags.
 * By default, it processes all logs in .roo-logs.
 * A specific session can be processed using the --sessionId flag.
 *
 * The goal is to leverage high-quality conversation data to train models for
 * specific agentic AI tasks within Roo Code.
 *
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini-supervised-tuning-prepare
 * @see https://platform.openai.com/docs/guides/supervised-fine-tuning
 */

// Interfaces based on ConversationLogger.ts and model formats
interface LogEntry {
	timestamp: string
	session_id: string
	type: "user_message" | "ai_response" | "tool_call"
	mode: string
	content?: string
	tool_calls?: { name: string; input: any }[]
	tool_name?: string
	parameters?: any
	result?: any
}

// Gemini Format
interface GeminiMessage {
	role: "user" | "model" | "tool"
	parts: ({ text: string } | { tool_code: any } | { tool_result: any })[]
}

interface GeminiExample {
	messages: GeminiMessage[]
}

// OpenAI Format
interface OpenAIToolCall {
	id: string
	type: "function"
	function: {
		name: string
		arguments: string
	}
}

interface OpenAIMessage {
	role: "user" | "assistant" | "tool"
	content: string | null
	tool_calls?: OpenAIToolCall[]
	tool_call_id?: string
	name?: string
}

interface OpenAIExample {
	messages: OpenAIMessage[]
}

type Provider = "gemini" | "openai"

/**
 * Parses command-line arguments.
 * @param args - Command-line arguments array.
 * @returns Parsed arguments.
 */
function parseArguments(args: string[]): {
	input: string
	output: string
	provider: Provider
	sessionId?: string
	depth?: number
} {
	const inputFlag = "--input"
	const outputFlag = "--output"
	const sessionIdFlag = "--sessionId"
	const depthFlag = "--depth"
	let input = ".roo-logs"
	let output = "finetuning-datasets"
	let provider: Provider = "gemini"
	let sessionId: string | undefined
	let depth: number | undefined

	if (args.includes("--openai")) {
		provider = "openai"
	} else if (args.includes("--gemini")) {
		provider = "gemini"
	}

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		const value = args[i + 1]

		if (arg === inputFlag && value && !value.startsWith("--")) {
			input = value
			i++
		} else if (arg === outputFlag && value && !value.startsWith("--")) {
			output = value
			i++
		} else if (arg === sessionIdFlag && value && !value.startsWith("--")) {
			sessionId = value
			i++
		} else if (arg === depthFlag && value && !isNaN(parseInt(value))) {
			depth = parseInt(value, 10)
			i++
		}
	}

	return { input, output, provider, sessionId, depth }
}

/**
 * Finds all .jsonl files in a directory.
 * @param dir - The directory to search.
 * @returns A promise that resolves to an array of file paths.
 */
async function findLogFiles(dir: string): Promise<string[]> {
	try {
		const dirents = await fs.readdir(dir, { withFileTypes: true })
		const files = await Promise.all(
			dirents.map(async (dirent) => {
				const res = path.resolve(dir, dirent.name)
				if (dirent.isDirectory()) {
					return findLogFiles(res)
				}
				return res.endsWith(".jsonl") ? res : []
			}),
		)
		return Array.prototype.concat(...files)
	} catch (error) {
		console.error(`Error reading directory ${dir}:`, error)
		return []
	}
}

/**
 * Processes a single session log file for the Gemini format.
 * @param filePath - The path to the log file.
 * @returns A promise that resolves to an array of GeminiExample objects.
 */
async function processLogFileForGemini(filePath: string): Promise<GeminiExample[]> {
	const fileContent = await fs.readFile(filePath, "utf-8")
	const lines = fileContent.split(/\r?\n/).filter((line) => line)
	const logEntries: LogEntry[] = lines
		.map((line) => {
			try {
				return JSON.parse(line)
			} catch (error) {
				console.warn(`Skipping malformed log entry: ${line}`)
				return null
			}
		})
		.filter((entry): entry is LogEntry => entry !== null)

	const examples: GeminiExample[] = []
	let i = 0

	while (i < logEntries.length) {
		const currentEntry = logEntries[i]
		if (currentEntry?.type === "user_message") {
			const turn: LogEntry[] = []
			let j = i
			// Collect all entries until the next user message
			while (j < logEntries.length && (j === i || logEntries[j]?.type !== "user_message")) {
				const entry = logEntries[j]
				if (entry) {
					turn.push(entry)
				}
				j++
			}

			// Process the collected turn
			const messages: GeminiMessage[] = []
			const firstMessage = turn[0]
			if (!firstMessage) {
				i = j
				continue
			}

			messages.push({ role: "user", parts: [{ text: firstMessage.content ?? "" }] })

			const modelResponses: GeminiMessage[] = []
			const toolResults: GeminiMessage[] = []

			for (let k = 1; k < turn.length; k++) {
				const entry = turn[k]
				if (!entry) continue

				if (entry.type === "ai_response") {
					const modelResponseParts: ({ text: string } | { tool_code: any })[] = []
					if (entry.content) {
						modelResponseParts.push({ text: entry.content })
					}
					if (entry.tool_calls && entry.tool_calls.length > 0) {
						modelResponseParts.push(
							...entry.tool_calls.map((tc) => ({ tool_code: { name: tc.name, args: tc.input } })),
						)
					}
					if (modelResponseParts.length > 0) {
						modelResponses.push({ role: "model", parts: modelResponseParts })
					}
				} else if (entry.type === "tool_call") {
					const toolOutput =
						typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result, null, 2)

					toolResults.push({
						role: "tool",
						parts: [
							{
								tool_result: {
									name: entry.tool_name!,
									response: toolOutput,
								},
							},
						],
					})
				}
			}

			// Re-order the messages to ensure the model's tool call comes before the tool result.
			const modelResponsesWithToolCalls = modelResponses.filter((m) => m.parts.some((p) => "tool_code" in p))
			const modelSummaries = modelResponses.filter((m) => !m.parts.some((p) => "tool_code" in p))

			// A valid turn must have some model response.
			if (modelResponses.length > 0) {
				messages.push(...modelResponsesWithToolCalls)
				messages.push(...toolResults)
				messages.push(...modelSummaries)
				examples.push({ messages })
			}
			i = j
		} else {
			i++
		}
	}
	return examples
}

/**
 * Processes a single session log file for the OpenAI format.
 * @param filePath - The path to the log file.
 * @returns A promise that resolves to an array of OpenAIExample objects.
 */
async function processLogFileForOpenAI(filePath: string): Promise<OpenAIExample[]> {
	const fileContent = await fs.readFile(filePath, "utf-8")
	const lines = fileContent.split(/\r?\n/).filter((line) => line)
	const logEntries: LogEntry[] = lines
		.map((line) => {
			try {
				return JSON.parse(line)
			} catch (error) {
				console.warn(`Skipping malformed log entry: ${line}`)
				return null
			}
		})
		.filter((entry): entry is LogEntry => entry !== null)

	const examples: OpenAIExample[] = []
	let i = 0

	while (i < logEntries.length) {
		const currentEntry = logEntries[i]
		if (currentEntry?.type === "user_message") {
			const turn: LogEntry[] = []
			let j = i
			while (j < logEntries.length && (j === i || logEntries[j]?.type !== "user_message")) {
				const entry = logEntries[j]
				if (entry) {
					turn.push(entry)
				}
				j++
			}

			const messages: OpenAIMessage[] = []
			const firstMessage = turn[0]
			if (!firstMessage || !firstMessage.content) {
				i = j
				continue
			}

			messages.push({ role: "user", content: firstMessage.content })

			const toolCallIdQueue: string[] = []
			let toolCallCounter = 0

			for (let k = 1; k < turn.length; k++) {
				const entry = turn[k]
				if (!entry) continue

				if (entry.type === "ai_response") {
					if (entry.tool_calls && entry.tool_calls.length > 0) {
						const toolCalls: OpenAIToolCall[] = entry.tool_calls.map((tc) => {
							const toolCallId = `call_${toolCallCounter++}`
							toolCallIdQueue.push(toolCallId)
							return {
								id: toolCallId,
								type: "function",
								function: {
									name: tc.name,
									arguments: JSON.stringify(tc.input),
								},
							}
						})
						messages.push({ role: "assistant", content: null, tool_calls: toolCalls })
					} else if (entry.content) {
						messages.push({ role: "assistant", content: entry.content })
					}
				} else if (entry.type === "tool_call" && entry.tool_name) {
					const toolCallId = toolCallIdQueue.shift()
					if (toolCallId) {
						messages.push({
							role: "tool",
							tool_call_id: toolCallId,
							name: entry.tool_name,
							content: typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result),
						})
					}
				}
			}

			// Ensure there's at least one assistant response.
			if (messages.some((m) => m.role === "assistant")) {
				examples.push({ messages })
			}

			i = j
		} else {
			i++
		}
	}
	return examples
}

/**
 * Main function to run the script.
 */
export async function main(argv: string[]) {
	const { input, output, provider, sessionId, depth } = parseArguments(argv)

	// When running from tests, the paths might be absolute. Otherwise, resolve from cwd.
	const inputDir = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input)
	const outputDir = path.isAbsolute(output) ? output : path.resolve(process.cwd(), output)

	await fs.mkdir(outputDir, { recursive: true })

	// Suppress console logs during tests, but not during normal execution.
	const log = process.env.VITEST ? () => {} : console.log

	log(`Starting conversion for ${provider}...`)
	log(`Input directory: ${inputDir}`)
	log(`Output directory: ${outputDir}`)
	if (sessionId) {
		log(`Processing only session: ${sessionId}`)
	}
	if (depth) {
		log(`Processing up to ${depth} most recent log files.`)
	}

	let logFiles = await findLogFiles(inputDir)

	if (sessionId) {
		logFiles = logFiles.filter((file) => path.basename(file, ".jsonl") === sessionId)
		if (logFiles.length === 0) {
			// Suppress console logs during tests
			if (!process.env.VITEST) {
				console.warn(`No log file found for session ID: ${sessionId}`)
			}
			return
		}
	} else {
		// Sort by modification time, most recent first
		const fileStats = await Promise.all(
			logFiles.map(async (file) => ({
				file,
				stats: await fs.stat(file),
			})),
		)
		fileStats.sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime())
		logFiles = fileStats.map((fs) => fs.file)

		// Apply depth limit
		if (depth && depth > 0) {
			logFiles = logFiles.slice(0, depth)
		}
	}

	if (logFiles.length === 0) {
		log("No .jsonl log files found. Exiting.")
		return
	}

	let totalExamples = 0
	for (const file of logFiles) {
		const currentSessionId = path.basename(file, ".jsonl")
		const outputFileName = `sft-dataset-${provider}-${currentSessionId}.jsonl`
		const outputFile = path.join(outputDir, outputFileName)

		const examples =
			provider === "openai" ? await processLogFileForOpenAI(file) : await processLogFileForGemini(file)

		if (examples.length > 0) {
			const outputContent = examples.map((ex) => JSON.stringify(ex)).join(EOL)
			await fs.writeFile(outputFile, outputContent, "utf-8")
			log(
				`Successfully created ${provider} fine-tuning dataset for session ${currentSessionId} with ${examples.length} examples at ${outputFile}`,
			)
			totalExamples += examples.length
		}
	}

	if (totalExamples > 0) {
		log(`\nFinished. Total examples generated: ${totalExamples}.`)
	} else {
		log("No valid training examples could be be generated from the logs.")
	}
}

// This allows the script to be run directly from the command line
if (require.main === module) {
	main(process.argv.slice(2)).catch((error) => {
		console.error("An unexpected error occurred:", error)
		process.exit(1)
	})
}
