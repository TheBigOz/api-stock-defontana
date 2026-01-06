const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

// Permite que tu web uni-t.cl se comunique con este servidor (CORS)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); 
    next();
});

app.get('/consultar', async (req, res) => {
    const producto = req.query.sku; // Recibimos el SKU desde la URL

    if (!producto) {
        return res.status(400).json({ error: 'Falta el parámetro SKU' });
    }

    console.log(`Iniciando consulta para: ${producto}`);

    let browser = null;
    try {
        // Configuración para correr en la nube (Render/Railway)
        browser = await puppeteer.launch({
            headless: true, // Oculto
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process' // Importante para servidores con poca memoria
            ]
        });

        const page = await browser.newPage();
        
        // 1. LOGIN
        await page.goto('https://gw.defontana.com/login', { waitUntil: 'networkidle2' });

        // Llenamos usuario
        await page.waitForSelector('input[formcontrolname="email"]');
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); // <--- PON TU CORREO REAL

        // Llenamos contraseña
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); // <--- PON TU CLAVE REAL

        // Click en botón entrar (clase que me diste)
        await page.click('button.df-primario');
        
        // Esperamos a navegar
        await page.waitForNavigation({ waitUntil: 'networkidle0' });

        // 2. BUSQUEDA (Lógica pendiente de ajuste fino)
        // Por ahora, vamos a devolver una confirmación de que entramos
        const tituloPagina = await page.title();
        
        // AQUÍ ES DONDE LUEGO AGREGAREMOS LA LÓGICA DE BUSCAR EL PRODUCTO
        // ...

        res.json({
            status: 'ok',
            mensaje: 'Login exitoso en Defontana',
            pagina_actual: tituloPagina,
            producto_buscado: producto
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error en el servidor', detalle: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(port, () => {
    console.log(`Servidor escuchando en el puerto ${port}`);

});
