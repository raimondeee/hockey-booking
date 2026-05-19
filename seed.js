const db = require('./database');

// Sample: Create a weekly recurring Monday clinic for the next 4 weeks
db.serialize(() => {
    const stmt = db.prepare("INSERT INTO sessions (title, start_time, end_time, price) VALUES (?, ?, ?, ?)");
    
    // Example: Adding dates manually or dynamically 
    stmt.run("Elite Defense Clinic", "2026-06-01T18:00:00", "2026-06-01T19:30:00", 45.00);
    stmt.run("Elite Defense Clinic", "2026-06-08T18:00:00", "2026-06-08T19:30:00", 45.00);
    
    stmt.finalize();
    console.log("Database seeded successfully!");
});