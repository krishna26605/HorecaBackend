const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;

async function check() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log("Connected to DB");
        
        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        for (const col of collections) {
            const name = col.name;
            const documents = await db.collection(name).find({
                $or: [
                    { email: 'food@gmail.com' },
                    { username: 'food@gmail.com' },
                    { "departmentContacts.routePlanner.email": 'food@gmail.com' },
                    { "departmentContacts.art.email": 'food@gmail.com' },
                    { "departmentContacts.act.email": 'food@gmail.com' },
                    { "departmentContacts.odt.email": 'food@gmail.com' },
                    { "departmentContacts.scm.email": 'food@gmail.com' }
                ]
            }).toArray();
            
            if (documents.length > 0) {
                console.log(`\nFound matches in collection [${name}]:`);
                console.log(JSON.stringify(documents, null, 2));
            }
        }
        
        process.exit(0);
    } catch (err) {
        console.error("ERROR:", err);
        process.exit(1);
    }
}

check();
