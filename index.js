const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;
const TESSERACT_PATH = 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe';

// Create required directories if they don't exist
const ensureDirectoryExists = (directory) => {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }
};

ensureDirectoryExists('uploads');
ensureDirectoryExists('output');

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));

// Helper functions
const cleanupFiles = (imagePath, outputBase) => {
    try {
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        if (fs.existsSync(`${outputBase}.txt`)) fs.unlinkSync(`${outputBase}.txt`);
        if (fs.existsSync(`${outputBase}.tsv`)) fs.unlinkSync(`${outputBase}.tsv`);
    } catch (error) {
        console.error('Cleanup error:', error);
    }
};

const isValidBase64Image = (base64String) => {
    try {
        const buffer = Buffer.from(base64String, 'base64');
        const firstBytes = buffer.toString('hex', 0, 4).toLowerCase();
        return ['ffd8', '8950', '4749'].some(sig => firstBytes.startsWith(sig)); // jpg, png, gif signatures
    } catch (error) {
        return false;
    }
};

const VALID_BBOX_TYPES = new Set(['word', 'line', 'paragraph', 'block', 'page']);

// OCR Route for getting text
app.post('/api/get-text', (req, res) => {
    const { base64_image } = req.body;

    if (!base64_image || !isValidBase64Image(base64_image)) {
        return res.status(400).json({ success: false, error: { message: "Invalid base64_image." } });
    }

    const buffer = Buffer.from(base64_image, 'base64');
    const imagePath = path.join('uploads', `image_${Date.now()}.png`);
    const outputPath = path.join('output', `image_${Date.now()}`);

    fs.writeFile(imagePath, buffer, (err) => {
        if (err) {
            console.error('Write File Error:', err);
            return res.status(500).json({ success: false, error: { message: "Error saving image." } });
        }

        exec(`"${TESSERACT_PATH}" "${imagePath}" "${outputPath}"`, (err, stdout, stderr) => {
            if (err) {
                console.error('Tesseract Error:', err);
                cleanupFiles(imagePath, outputPath);
                return res.status(500).json({ success: false, error: { message: `Error processing image: ${stderr}` } });
            }

            fs.readFile(`${outputPath}.txt`, 'utf8', (err, data) => {
                if (err) {
                    console.error('Read File Error:', err);
                    cleanupFiles(imagePath, outputPath);
                    return res.status(500).json({ success: false, error: { message: "Error reading output file." } });
                }

                cleanupFiles(imagePath, outputPath);
                res.json({ success: true, result: { text: data.trim() } });
            });
        });
    });
});

// OCR Route for getting bounding boxes
app.post('/api/get-bboxes', (req, res) => {
    const { base64_image, bbox_type } = req.body;

    if (!base64_image || !isValidBase64Image(base64_image)) {
        return res.status(400).json({ success: false, error: { message: "Invalid base64_image." } });
    }

    if (!bbox_type || !VALID_BBOX_TYPES.has(bbox_type)) {
        return res.status(400).json({ success: false, error: { message: "Invalid bbox_type." } });
    }

    const buffer = Buffer.from(base64_image, 'base64');
    const imagePath = path.join('uploads', `image_${Date.now()}.png`);
    const outputPath = path.join('output', `image_${Date.now()}`);

    fs.writeFile(imagePath, buffer, (err) => {
        if (err) {
            console.error('Write File Error:', err);
            return res.status(500).json({ success: false, error: { message: "Error saving image." } });
        }

        exec(`"${TESSERACT_PATH}" "${imagePath}" "${outputPath}" -c tessedit_create_tsv=1`, (err, stdout, stderr) => {
            if (err) {
                console.error('Tesseract Error:', err);
                cleanupFiles(imagePath, outputPath);
                return res.status(500).json({ success: false, error: { message: `Error processing image: ${stderr}` } });
            }

            fs.readFile(`${outputPath}.tsv`, 'utf8', (err, data) => {
                if (err) {
                    console.error('Read File Error:', err);
                    cleanupFiles(imagePath, outputPath);
                    return res.status(500).json({ success: false, error: { message: "Error reading output file." } });
                }

                // Parse TSV data and extract bounding boxes
                const lines = data.split('\n').slice(1); // Skip header row
                const bboxes = lines
                    .filter(line => line.trim())
                    .map(line => {
                        const [level, page_num, block_num, par_num, line_num, word_num, left, top, width, height, conf, text] = line.split('\t');
                        return {
                            text: text.trim(),
                            confidence: parseFloat(conf),
                            x_min: parseInt(left),
                            y_min: parseInt(top),
                            x_max: parseInt(left) + parseInt(width),
                            y_max: parseInt(top) + parseInt(height)
                        };
                    });

                cleanupFiles(imagePath, outputPath);
                res.json({ success: true, result: { bboxes: bboxes, bbox_type } });
            });
        });
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: { message: "Internal server error" } });
});

// Start server
app.listen(PORT, () => {
    console.log(`OCR Server running on port ${PORT}`);
});

// Handle process termination
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Cleaning up...');
    try {
        fs.readdirSync('uploads').forEach(file => fs.unlinkSync(path.join('uploads', file)));
        fs.readdirSync('output').forEach(file => fs.unlinkSync(path.join('output', file)));
    } catch (error) {
        console.error('Cleanup error during shutdown:', error);
    }
});
