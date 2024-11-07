const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const natural = require('natural');
const cors = require('cors');
const compromise = require('compromise');

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

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

// Fetch questions from the database
async function getQuestionsFromDb() {
    const connection = await db();
    const [rows] = await connection.execute('SELECT id, question FROM dataset_questions WHERE status = ?', ['active']);
    await connection.end();
    return rows;
}

// Fetch answer from the database by question ID
async function getAnswerFromDb(id) {
    const connection = await db();
    const [rows] = await connection.execute('SELECT answer FROM dataset_questions WHERE id = ?', [id]);
    await connection.end();
    return rows.length > 0 ? rows[0].answer : null;
}

async function getBestMatch(userQuery) {
    let highestScore = 0;
    let bestMatchId = null;


    const tokenizer = new natural.WordTokenizer();
    const stemmer = natural.PorterStemmer;
    const userTokens = tokenizer.tokenize(userQuery).map(word => stemmer.stem(word));

    const questions = await getQuestionsFromDb();

    questions.forEach(({ id, question }) => {
        const questionTokens = tokenizer.tokenize(question).map(word => stemmer.stem(word));
        const intersection = userTokens.filter(word => questionTokens.includes(word));
        const union = new Set([...userTokens, ...questionTokens]);
        const lexicalSimilarity = intersection.length / union.size;

        const semanticMatch = compromise(question).match(userQuery);
        const semanticSimilarity = semanticMatch.found ? 1 : 0.5;

        const totalScore = (lexicalSimilarity + semanticSimilarity) / 2;

        if (totalScore > highestScore) {
            highestScore = totalScore;
            bestMatchId = id;
        }
    });

    return bestMatchId;
}

async function getBestMatchUsingHF(userQuery) {
    async function query(data) {
        const response = await fetch(
            "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2",
            {
                headers: {
                    Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
                    "Content-Type": "application/json",
                },
                method: "POST",
                body: JSON.stringify(data),
            }
        );
        const result = await response.json();
        return result;
    }

    const rows = await getQuestionsFromDb();
    const questionsArray = rows.map((row) => row.question);
    const idsArray = rows.map((row) => row.id);

    try {
        const response = await query({
            "inputs": {
                "source_sentence": userQuery,
                "sentences": questionsArray
            }
        });

        const bestMatch = Math.max(...response);
        if(bestMatch < 0.7){
            return null;
        }
        const bestMatchIndex = response.indexOf(bestMatch);
        const bestMatchId = idsArray[bestMatchIndex];
        return bestMatchId;
    } catch (error) {
        console.error("Error:", error);
        throw new Error("Something went wrong!");
    }
}


app.post('/api/response', async (req, res) => {
    const {question:userQuery} = req.body;
    if (!userQuery) return res.status(400).json({ error: "Question field required" });
    let bestMatchId
    try{
        bestMatchId = await getBestMatchUsingHF(userQuery)
    }catch(err){
        bestMatchId = await getBestMatch(userQuery)
    }

    if (bestMatchId) {
        const answer = await getAnswerFromDb(bestMatchId);
        res.json({ answer });
    } else {
        res.json({ answer: "I am not trained enough to answer this question." });
    }
});

// Route to get the client IP address
app.get('/api/ip', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown IP';
    const formattedIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    res.json({ ip: formattedIp });
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
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
