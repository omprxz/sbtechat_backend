import express from 'express';
import mysql from 'mysql2/promise';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import natural from 'natural';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

let questionsList = [];
let genAI;

const initializeGenAI = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    genAI = new GoogleGenerativeAI(apiKey);
};

// Database connection
const db = async () => {
    return await mysql.createConnection({
        host: process.env.MYSQL_HOST,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DB,
        port: process.env.MYSQL_PORT,
    });
};

// Route to get the client IP address
app.get('/api/ip', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown IP';
    const formattedIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    res.json({ ip: formattedIp });
});

// Route to create a new chat session
app.post('/api/newchat', async (req, res) => {
    const { ip } = req.body;
    const connection = await db();
    try {
        const createChatSQL = 'INSERT INTO chat_sessions (ip) VALUES (?)';
        const [chat] = await connection.execute(createChatSQL, [ip]);
        res.json({ chatId: chat.insertId });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        await connection.end();
    }
});

// Helper functions for AI
const fetchQuestionsList = async () => {
    const connection = await db();
    const [rows] = await connection.query(
        "SELECT question, answer FROM dataset_questions WHERE status = 'active'"
    );
    questionsList = rows;
};

const genAIQuery = async (question, chatHistory = []) => {
    const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction:
            'You are an intelligent chatbot designed to assist students...',
    });

    const generationConfig = {
        temperature: 1,
        topP: 0.95,
        topK: 64,
        maxOutputTokens: 8192,
        responseMimeType: "text/plain",
    };

    let chatSession;
    if (chatHistory) {
        const history = chatHistory.map(message => ({
            role: message.type === "user" ? "user" : "model",
            parts: [{ text: message.message }],
        }));
        chatSession = model.startChat({
            generationConfig,
            history,
        });
    } else {
        chatSession = model.startChat({
            generationConfig,
        });
    }
    
    const result = await chatSession.sendMessage(question);
    return result.response.text();
};

// Route for chat response
app.post('/api/response', async (req, res) => {
    const { question: userQuestion, ip, chatId, isFirst, history: chatHistory } = req.body;
    if (!userQuestion) return res.status(400).json({ error: "User question is required" });

    let connection;
    try {
        if (isFirst || questionsList.length === 0) await fetchQuestionsList();
        if (isFirst || !genAI) initializeGenAI();

        let bestMatch = { question: null, answer: null, score: 0 };
        questionsList.forEach(({ question, answer }) => {
            const similarity = natural.JaroWinklerDistance(userQuestion.toLowerCase(), question.toLowerCase());
            if (similarity > bestMatch.score) bestMatch = { question, answer, score: similarity };
        });
        let finalAnswer = bestMatch.score > 0.7 ? bestMatch.answer : await genAIQuery(userQuestion, chatHistory) || "I'm still learning and don't have an answer for that.";

        connection = await db();
        const messageSql = 'INSERT INTO chatbot_questions (question, ip, chat_id) VALUES (?, ?, ?)';
        const [messageResult] = await connection.execute(messageSql, [userQuestion, ip, Number(chatId)]);

        const updateAnswerSql = 'UPDATE chatbot_questions SET answer = ? WHERE id = ?';
        await connection.execute(updateAnswerSql, [finalAnswer, messageResult.insertId]);

        const appendToChatSql = `
            UPDATE chat_sessions 
            SET msg_ids = COALESCE(
                JSON_ARRAY_APPEND(msg_ids, '$', CAST(? AS UNSIGNED)), 
                JSON_ARRAY(CAST(? AS UNSIGNED))
            ) 
            WHERE id = ?;
        `;
        await connection.execute(appendToChatSql, [messageResult.insertId, messageResult.insertId, chatId]);

        res.json({ answer: finalAnswer });
    } catch (error) {
        console.error("Error generating response:", error);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        if (connection) await connection.end();
    }
});

// Route to suggest questions based on input
app.post('/api/question/suggest/input', async (req, res) => {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: "Input field required" });

    let connection;
    try {
        connection = await db();
        const getQSql = `SELECT question FROM dataset_questions WHERE question LIKE ? LIMIT 5`;
        const [questions] = await connection.execute(getQSql, [`%${input}%`]);
        res.json({ questions });
    } catch (error) {
        res.status(500).json({ error: error.message || "Something went wrong!" });
    } finally {
        if (connection) await connection.end();
    }
});

// Route to get top questions by count
app.get('/api/question/suggest/:count', async (req, res) => {
    const count = parseInt(req.params.count, 10);
    if (isNaN(count) || count <= 0) return res.status(400).json({ error: "Invalid count parameter" });

    let connection;
    try {
        connection = await db();
        const getQSql = `SELECT question FROM dataset_questions where status = 'active' ORDER BY created_at DESC LIMIT ${count}`;
        const [questions] = await connection.execute(getQSql);
        res.json({ questions });
    } catch (error) {
        console.error("Error fetching questions:", error);
        res.status(500).json({ error: "An error occurred while fetching questions" });
    } finally {
        if (connection) await connection.end();
    }
});

app.get("/", (req, res) => {
    res.send("Chatbot backend running...");
})

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
