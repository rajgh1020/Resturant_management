const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'rg123@raj', // CHECK YOUR PASSWORD
    database: 'restaurant_management_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.use(express.static(path.join(__dirname, 'public')));

async function getFullState() {
    try {
        // Fetch Menu sorted by Category
        const [menu] = await pool.query("SELECT * FROM menu_items ORDER BY category, name");
        const [inv] = await pool.query("SELECT * FROM inventory");
        const [tables] = await pool.query("SELECT * FROM restaurant_tables");
        
        const [ordersRaw] = await pool.query("SELECT * FROM orders WHERE status != 'Completed' OR payment_status = 'Unpaid' ORDER BY id DESC");
        
        const orders = await Promise.all(ordersRaw.map(async (order) => {
            const [items] = await pool.query("SELECT item_name as name, price FROM order_items WHERE order_id = ?", [order.id]);
            return {
                id: order.id,
                table: order.table_no,
                status: order.status,
                payment_status: order.payment_status, 
                total: parseFloat(order.total_amount || 0),
                time: new Date(order.created_at).toLocaleTimeString(),
                items: items
            };
        }));

        const [revResult] = await pool.query("SELECT SUM(total_amount) as total FROM orders WHERE payment_status = 'Paid'");
        const [cntResult] = await pool.query("SELECT COUNT(*) as count FROM orders");

        const [billsRaw] = await pool.query("SELECT table_no, SUM(total_amount) as bill FROM orders WHERE payment_status = 'Unpaid' GROUP BY table_no");
        const tableBills = {};
        tables.forEach(t => tableBills[t.id] = 0);
        billsRaw.forEach(b => tableBills[b.table_no] = parseFloat(b.bill || 0));

        return { 
            menu, inventory: inv, tables, orders, 
            revenue: parseFloat(revResult[0].total || 0), 
            totalOrders: cntResult[0].count || 0,
            tableBills 
        };

    } catch (err) {
        console.error("DB Error:", err);
        return { menu: [], inventory: [], tables: [], orders: [], revenue: 0, totalOrders: 0, tableBills: {} };
    }
}

io.on('connection', async (socket) => {
    socket.emit('init_data', await getFullState());

    socket.on('login_attempt', async ({ username, password }) => {
        try {
            const [rows] = await pool.execute("SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
            rows.length > 0 ? socket.emit('login_success', { role: rows[0].role, name: rows[0].name }) : socket.emit('login_error', "Invalid Credentials");
        } catch (e) { socket.emit('login_error', "DB Error"); }
    });

    // --- MENU MANAGEMENT HANDLERS ---
    socket.on('add_menu_item', async (item) => {
        try {
            console.log("Adding Item:", item); // Debug Log
            await pool.execute(
                "INSERT INTO menu_items (name, category, price, icon, description, allergens) VALUES (?, ?, ?, ?, ?, ?)",
                [item.name, item.category, item.price, item.icon, item.desc, item.allergens]
            );
            // Broadcast new state to everyone
            io.emit('sync_state', await getFullState());
        } catch (e) { console.error("Add Menu Error:", e); }
    });

    socket.on('delete_menu_item', async (id) => {
        try {
            // Delete recipes first to avoid foreign key error
            await pool.execute("DELETE FROM recipes WHERE menu_item_id = ?", [id]);
            await pool.execute("DELETE FROM menu_items WHERE id = ?", [id]);
            io.emit('sync_state', await getFullState());
        } catch (e) { console.error("Delete Menu Error:", e); }
    });
    // --------------------------------

    socket.on('place_order', async (orderData) => {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const [res] = await connection.execute("INSERT INTO orders (table_no, total_amount, status, payment_status) VALUES (?, ?, 'Pending', 'Unpaid')", [orderData.table, orderData.total]);
            const newId = res.insertId;

            for (const item of orderData.items) {
                await connection.execute("INSERT INTO order_items (order_id, item_name, price) VALUES (?, ?, ?)", [newId, item.name, item.price]);
                // Deduct Inventory Logic (Simplified for stability)
                const [recipes] = await connection.execute("SELECT inventory_item_id, quantity_needed FROM recipes WHERE menu_item_id = ?", [item.id]);
                for (const r of recipes) {
                    await connection.execute("UPDATE inventory SET quantity_on_hand = GREATEST(0, quantity_on_hand - ?) WHERE id = ?", [r.quantity_needed, r.inventory_item_id]);
                }
            }
            
            await connection.execute("UPDATE restaurant_tables SET status = 'Occupied' WHERE id = ?", [orderData.table]);
            await connection.commit();
            io.emit('sync_state', await getFullState());

        } catch (e) { await connection.rollback(); console.error(e); } finally { connection.release(); }
    });

    socket.on('pay_bill', async (tableId) => {
        try {
            await pool.execute("UPDATE orders SET payment_status = 'Paid' WHERE table_no = ? AND payment_status = 'Unpaid'", [tableId]);
            await pool.execute("UPDATE restaurant_tables SET status = 'Cleaning' WHERE id = ?", [tableId]);
            io.emit('sync_state', await getFullState());
        } catch (e) { console.error(e); }
    });

    socket.on('reset_table', async (tableId) => {
        try {
            await pool.execute("UPDATE restaurant_tables SET status = 'Available' WHERE id = ?", [tableId]);
            io.emit('sync_state', await getFullState());
        } catch (e) { console.error(e); }
    });

    socket.on('update_status', async ({ id, status }) => {
        try {
            await pool.execute("UPDATE orders SET status = ? WHERE id = ?", [status, id]);
            io.emit('sync_state', await getFullState());
        } catch (e) { console.error(e); }
    });
    
    socket.on('restock_item', async ({ id, amount }) => {
        try {
            await pool.execute("UPDATE inventory SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?", [amount, id]);
            io.emit('sync_state', await getFullState());
        } catch(e) { console.error(e); }
    });

    socket.on('generate_report', async () => {
        try {
            const [data] = await pool.query("SELECT id, table_no, total_amount, created_at FROM orders WHERE payment_status = 'Paid' ORDER BY created_at DESC");
            socket.emit('report_data', data);
        } catch (e) { console.error(e); }
    });
});

server.listen(3000, () => console.log('RMS LIVE: http://localhost:3000'));