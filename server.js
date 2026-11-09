const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "database", "db.json");

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch (err) {
    return { users: [], otps: [], items: [], messages: [] };
  }
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function sanitizeUser(u) {
  const { password, ...safe } = u;
  return safe;
}

// Generate unique seller username based on name + random chars/numbers
function generateSellerUsername(name, db) {
  const cleanName = (name || "farmer").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  const randSuffix = Math.random().toString(36).substring(2, 6) + Math.floor(10 + Math.random() * 90);
  const username = `${cleanName}_${randSuffix}`;
  
  // Ensure uniqueness
  if (db.users.some(u => u.username === username)) {
    return generateSellerUsername(name, db);
  }
  return username;
}

// SIGN UP (No Admin signup allowed)
app.post("/api/auth/signup", (req, res) => {
  const { name, phone, location, password } = req.body;
  if (!name || !phone || !password) {
    return res.status(400).json({ success: false, message: "Name, mobile number, and password are required." });
  }
  const cleanPhone = String(phone).trim();
  if (cleanPhone.toLowerCase() === "admin") {
    return res.status(403).json({ success: false, message: "Admin account cannot be registered via Sign Up." });
  }

  const db = readDb();
  if (db.users.find((u) => u.phone === cleanPhone)) {
    return res.status(400).json({ success: false, message: "Mobile number already registered. Please Login." });
  }

  const newUser = {
    id: db.users.length > 0 ? Math.max(...db.users.map((u) => u.id)) + 1 : 1,
    name: name.trim(),
    phone: cleanPhone,
    password: String(password).trim(),
    location: (location || "Karnataka").trim(),
    is_admin: false,
    is_seller_registered: false,
    farm_name: null,
    aadhaar_number: null,
    username: null,
    upi_id: null
  };
  db.users.push(newUser);
  writeDb(db);
  res.json({ success: true, message: "Account created successfully!", user: sanitizeUser(newUser) });
});

// LOGIN (Supports mobile number or admin username 'admin' and password 'daRshaN')
app.post("/api/auth/login", (req, res) => {
  const { identifier, password } = req.body; // identifier can be phone or username
  const cleanId = String(identifier || "").trim();
  const cleanPass = String(password || "").trim();

  const db = readDb();
  const user = db.users.find((u) => (u.phone === cleanId || u.username === cleanId || (u.is_admin && cleanId === "admin")) && u.password === cleanPass);

  if (!user) {
    return res.status(401).json({ success: false, message: "Invalid credentials. Please check your mobile number/username and password." });
  }
  res.json({ success: true, message: "Login successful!", user: sanitizeUser(user) });
});

// FORGOT PASSWORD OTP
app.post("/api/auth/forgot-password/send-otp", (req, res) => {
  const { phone } = req.body;
  const cleanPhone = String(phone || "").trim();
  const db = readDb();
  const user = db.users.find((u) => u.phone === cleanPhone);
  if (!user) return res.status(404).json({ success: false, message: "Mobile number not found." });

  const otpCode = String(Math.floor(100000 + Math.random() * 900000));
  db.otps = (db.otps || []).filter((o) => o.phone !== cleanPhone);
  db.otps.push({ phone: cleanPhone, otp_code: otpCode, expires_at: Date.now() + 10*60*1000 });
  writeDb(db);
  res.json({ success: true, demo_otp: otpCode });
});

app.post("/api/auth/forgot-password/reset", (req, res) => {
  const { phone, otp_code, new_password } = req.body;
  const db = readDb();
  const otpRecord = (db.otps || []).find((o) => o.phone === String(phone).trim() && o.otp_code === String(otp_code).trim());
  if (!otpRecord || Date.now() > otpRecord.expires_at) {
    return res.status(400).json({ success: false, message: "Invalid or expired OTP." });
  }
  const user = db.users.find((u) => u.phone === String(phone).trim());
  if (!user) return res.status(404).json({ success: false, message: "User not found." });

  user.password = String(new_password).trim();
  db.otps = db.otps.filter((o) => o.phone !== String(phone).trim());
  writeDb(db);
  res.json({ success: true, message: "Password updated successfully!" });
});

// SELLER REGISTRATION (Replaced Aadhaar KYC ID with Aadhaar Number, auto-generates username)
app.post("/api/seller/register", (req, res) => {
  const { user_id, farm_name, aadhaar_number, upi_id, location } = req.body;
  if (!user_id || !farm_name || !aadhaar_number) {
    return res.status(400).json({ success: false, message: "Farm Name and 12-digit Aadhaar Number are required." });
  }

  const cleanAadhaar = String(aadhaar_number).trim();
  if (cleanAadhaar.length < 12) {
    return res.status(400).json({ success: false, message: "Please enter a valid Aadhaar number (at least 12 digits)." });
  }

  const db = readDb();
  const user = db.users.find((u) => u.id === Number(user_id));
  if (!user) return res.status(404).json({ success: false, message: "User not found." });

  const generatedUsername = generateSellerUsername(user.name, db);

  user.is_seller_registered = true;
  user.farm_name = farm_name.trim();
  user.aadhaar_number = cleanAadhaar;
  user.username = generatedUsername;
  user.upi_id = (upi_id || "").trim();
  if (location) user.location = location.trim();

  writeDb(db);
  res.json({ 
    success: true, 
    message: `Seller registration successful! Your unique username is: @${generatedUsername}`, 
    user: sanitizeUser(user) 
  });
});

// UPLOAD ITEM WITH MANDATORY LIVE CAMERA PHOTO (Status = pending)
app.post("/api/items", (req, res) => {
  const { seller_id, crop_name, category, quantity_kg, price_per_kg, quality_grade, location, description, image_data, captured_at } = req.body;
  if (!image_data || !String(image_data).startsWith("data:image/")) {
    return res.status(400).json({ success: false, message: "Mandatory live camera picture missing." });
  }

  const db = readDb();
  const seller = db.users.find((u) => u.id === Number(seller_id));
  if (!seller || !seller.is_seller_registered) {
    return res.status(403).json({ success: false, message: "Seller registration required first." });
  }

  const newItem = {
    id: db.items.length > 0 ? Math.max(...db.items.map((i) => i.id)) + 1 : 101,
    seller_id: seller.id,
    seller_name: seller.name,
    seller_username: seller.username,
    seller_phone: seller.phone,
    farm_name: seller.farm_name || "Verified Farm",
    crop_name: String(crop_name || "").trim(),
    category: category || "Vegetables",
    quantity_kg: parseFloat(quantity_kg) || 100,
    price_per_kg: parseFloat(price_per_kg) || 25,
    quality_grade: quality_grade || "Grade A",
    location: location || seller.location || "Karnataka",
    description: description || "Fresh farm produce.",
    image_data,
    captured_at: captured_at || new Date().toLocaleString(),
    status: "pending", // Waiting for Admin Approval
    created_at: new Date().toISOString()
  };

  db.items.push(newItem);
  writeDb(db);
  res.json({ success: true, message: "Item & Live Camera Photo submitted for Admin approval!", item: newItem });
});

app.get("/api/items/approved", (req, res) => {
  const db = readDb();
  res.json({ success: true, items: db.items.filter((i) => i.status === "approved").reverse() });
});

app.get("/api/items/seller/:sellerId", (req, res) => {
  const db = readDb();
  res.json({ success: true, items: db.items.filter((i) => i.seller_id === Number(req.params.sellerId)).reverse() });
});

// ADMIN APPROVAL
app.get("/api/admin/items", (req, res) => {
  const db = readDb();
  res.json({
    success: true,
    pending: db.items.filter((i) => i.status === "pending").reverse(),
    all: db.items.slice().reverse()
  });
});

app.post("/api/admin/items/moderate", (req, res) => {
  const { item_id, status } = req.body;
  const db = readDb();
  const item = db.items.find((i) => i.id === Number(item_id));
  if (!item) return res.status(404).json({ success: false, message: "Item not found." });
  item.status = status;
  writeDb(db);
  res.json({ success: true, message: `Item marked as ${status.toUpperCase()}!`, item });
});

// CHAT PLATFORM API (Corrected & robust message pairing)
app.get("/api/chat/messages/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  const db = readDb();
  const userMessages = db.messages.filter((m) => m.sender_id === userId || m.receiver_id === userId);

  const partnersMap = {};
  userMessages.forEach((m) => {
    const partnerId = m.sender_id === userId ? m.receiver_id : m.sender_id;
    const partnerName = m.sender_id === userId ? m.receiver_name : m.sender_name;
    if (!partnersMap[partnerId]) {
      partnersMap[partnerId] = {
        partner_id: partnerId,
        partner_name: partnerName,
        last_message: m.text,
        last_item: m.item_name || "Crop Inquiry",
        timestamp: m.timestamp
      };
    } else {
      partnersMap[partnerId].last_message = m.text;
      partnersMap[partnerId].timestamp = m.timestamp;
    }
  });

  // Include all other registered users in directory
  const directory = db.users.filter((u) => u.id !== userId && !u.is_admin).map(sanitizeUser);
  res.json({ success: true, messages: userMessages, conversations: Object.values(partnersMap).reverse(), directory });
});

app.post("/api/chat/send", (req, res) => {
  const { sender_id, sender_name, receiver_id, receiver_name, item_name, text } = req.body;
  if (!sender_id || !receiver_id || !text) {
    return res.status(400).json({ success: false, message: "Missing chat details." });
  }

  const db = readDb();
  const newMsg = {
    id: db.messages.length > 0 ? Math.max(...db.messages.map((m) => m.id)) + 1 : 1,
    sender_id: Number(sender_id),
    sender_name: sender_name || "User",
    receiver_id: Number(receiver_id),
    receiver_name: receiver_name || "User",
    item_name: item_name || "Crop Inquiry",
    text: text.trim(),
    timestamp: new Date().toISOString()
  };
  db.messages.push(newMsg);
  writeDb(db);
  res.json({ success: true, message: newMsg });
});

app.listen(PORT, () => {
  console.log(`KrishiSetu running on http://localhost:${PORT}`);
});
