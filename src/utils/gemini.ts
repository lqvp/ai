import {
	GoogleGenerativeAI,
	HarmCategory,
	HarmBlockThreshold,
	Part,
} from "@google/generative-ai";
import config from "@/config.js";

export type GeminiOptions = {
	contents?: GeminiContents[];
	systemInstruction?: GeminiSystemInstruction;
	tools?: [{}];
};

export type GeminiParts = {
	inlineData?: {
		mimeType: string;
		data: string;
	};
	fileData?: {
		mimeType: string;
		fileUri: string;
	};
	text?: string;
}[];

export type GeminiSystemInstruction = {
	role: string;
	parts: [{ text: string }];
};

export type GeminiContents = {
	role: string;
	parts: GeminiParts;
};

export type GeminiResponse = {
	error?: boolean;
	errorCode?: number | null;
	errorMessage?: string | null;
	text?: string;
};

const geminiModel = config.geminiModel || "gemini-2.0-flash-exp";

export async function generateText(
	question: string,
	prompt: string,
	history?: { role: string; content: string }[],
	friendName?: string,
	fromMention: boolean = true,
	grounding: boolean = false,
	files: { type: string; base64: string }[] = [],
	youtubeUrls: string[] = []
): Promise<GeminiResponse> {
	try {
		if (!config.geminiApiKey) {
			throw new Error("Gemini API key is not configured");
		}

		const genAI = new GoogleGenerativeAI(config.geminiApiKey);
		const model = genAI.getGenerativeModel({ model: geminiModel });

		const now = new Date().toLocaleString("ja-JP", {
			timeZone: "Asia/Tokyo",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		});

		let systemInstructionText =
			prompt +
			"また、現在日時は" +
			now +
			"であり、これは回答の参考にし、絶対に時刻を聞かれるまで時刻情報は提供しないこと(なお、他の日時は無効とすること)。";

		if (friendName != undefined) {
			systemInstructionText +=
				"なお、会話相手の名前は" + friendName + "とする。";
		}

		if (!fromMention) {
			systemInstructionText +=
				"これらのメッセージは、あなたに対するメッセージではないことを留意し、返答すること(会話相手は突然話しかけられた認識している)。";
		}

		if (grounding) {
			systemInstructionText +=
				"返答のルール2: 以下の場合のみGoogle search with groundingを使用すること：\n" +
				"1. 質問が最新の情報や事実確認を必要とする場合\n" +
				"2. 質問が具体的なデータや統計を求める場合\n" +
				"3. 質問が特定のトピックについての最新の状況を求める場合\n" +
				"それ以外の一般的な会話や質問には、検索機能を使用せずに回答すること。";
		} else {
			systemInstructionText +=
				"返答のルール2: 検索機能は使用せず、あなたの知識の範囲内で回答すること。";
		}

		const chat = model.startChat({
			history:
				history?.map((entry) => ({
					role: entry.role,
					parts: [{ text: entry.content }],
				})) || [],
			generationConfig: {
				temperature: 0.7,
				topK: 40,
				topP: 0.95,
				maxOutputTokens: 2048,
			},
			safetySettings: [
				{
					category: HarmCategory.HARM_CATEGORY_HARASSMENT,
					threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
				},
				{
					category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
					threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
				},
				{
					category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
					threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
				},
				{
					category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
					threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
				},
			],
		});

		const parts: Part[] = [{ text: systemInstructionText }, { text: question }];

		for (const file of files) {
			parts.push({
				inlineData: {
					mimeType: file.type,
					data: file.base64,
				},
			} as Part);
		}

		for (const url of youtubeUrls) {
			parts.push({
				fileData: {
					mimeType: "video/mp4",
					fileUri: url,
				},
			} as Part);
		}

		const result = await chat.sendMessage(parts);

		const response = result.response;
		let responseText = response.text();

		if (grounding && response.candidates?.[0]?.groundingMetadata) {
			const metadata = response.candidates[0].groundingMetadata;
			let groundingMetadata = "";

			if (metadata.groundingChunks) {
				const chunks = metadata.groundingChunks.slice(0, 3);
				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i];
					if (chunk.web?.uri && chunk.web?.title) {
						groundingMetadata += `参考(${i + 1}): [${chunk.web.title}](${
							chunk.web.uri
						})\n`;
					}
				}
			}

			if (metadata.webSearchQueries?.length > 0) {
				groundingMetadata +=
					"検索ワード: " + metadata.webSearchQueries.join(",") + "\n";
			}

			responseText += groundingMetadata;
		}

		return { text: responseText };
	} catch (err: unknown) {
		let errorCode = null;
		let errorMessage: string | null = null;

		if (err && typeof err === "object" && "response" in err) {
			const httpError = err as any;
			errorCode = httpError.response?.statusCode;
			errorMessage = httpError.response?.statusMessage || httpError.message;
		} else if (err instanceof Error) {
			errorMessage = err.message;
		}

		return { error: true, errorCode, errorMessage };
	}
}
