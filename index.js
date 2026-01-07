const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) {
        return res.status(400).json({ error: 'Falta el parámetro SKU' });
    }

    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`--- Iniciando búsqueda para: ${skuLimpio} ---`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true, // TRUE para que funcione en Render
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        
        // Tiempos de espera generosos para evitar errores 500
        page.setDefaultNavigationTimeout(60000); 
        page.setDefaultTimeout(60000);

        await page.setViewport({ width: 1920, height: 1080 });
        
        // 1. LOGIN (En el Portal)
        console.log('1. Entrando al Portal...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });

        await page.waitForSelector('input[formcontrolname="email"]');
        
        // CREDENCIALES
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
   
        console.log('2. Enviando credenciales...');
        
        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('3. Login OK. Buscando enlace al ERP...');

        // 2. DETECTAR Y ABRIR NUEVA PESTAÑA
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        // Preparamos la trampa para capturar la nueva pestaña
        const newTargetPromise = browser.waitForTarget(target => target.opener() === page.target());
        
        // Hacemos clic (esto abre la nueva pestaña)
        await erpButton.click();
        console.log('4. Click en ERP Digital. Esperando nueva pestaña...');
        
        const newTarget = await newTargetPromise;
        const erpPage = await newTarget.page();
        
        if (!erpPage) throw new Error("No se pudo capturar la pestaña del ERP");

        // Configuramos la nueva pestaña
        erpPage.setDefaultNavigationTimeout(60000);
        erpPage.setDefaultTimeout(60000);
        await erpPage.setViewport({ width: 1920, height: 1080 });

        // IMPORTANTE: Esperamos que la nueva pestaña cargue su "Home" inicial
        // Si intentamos ir a "Artículos" demasiado rápido, Angular puede fallar.
        await erpPage.waitForNavigation({ waitUntil: 'domcontentloaded' });

        // 3. NAVEGACIÓN DIRECTA (Aquí aplicamos tu corrección)
        console.log('5. Pestaña lista. Saltando directo a Artículos...');
        const urlInventario = 'https://erp.defontana.com/#/Inventario/Inventario/Articulos';
        
        // Forzamos la URL
        await erpPage.goto(urlInventario, { waitUntil: 'networkidle2' });

        console.log('6. Módulo de Artículos cargado. Buscando input...');

        // 4. BÚSQUEDA DEL PRODUCTO
        const searchInputSelector = 'input[formcontrolname="searchInputText"]';
        
        // Esperamos el input
        await erpPage.waitForSelector(searchInputSelector);
        
        // Escribimos SKU y ENTER
        // (Borramos primero por seguridad)
        await erpPage.evaluate((sel) => document.querySelector(sel).value = "", searchInputSelector);
        await erpPage.type(searchInputSelector, skuLimpio);
        await erpPage.keyboard.press('Enter');

        console.log(`7. Buscando SKU: ${skuLimpio}`);

        // 5. ESPERAR Y LEER RESULTADOS
        // Esperamos a que la tabla cargue algo (damos 10s máximo)
        try {
            await erpPage.waitForSelector('.mat-column-id', { timeout: 10000 });
        } catch (e) {
            console.log('...No aparecieron resultados rápidos (posiblemente agotado)...');
        }

        const resultado = await erpPage.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            
            // Si no hay filas, retornamos null
            if (filas.length === 0) return null;

            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                // Verificamos si el código coincide (Exacto o Contenido)
                if (textoCodigo === sku) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                    return {
                        codigo: textoCodigo,
                        descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                        stock: celdaStock ? celdaStock.innerText.trim() : '0',
                        precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                    };
                }
            }
            return null;
        }, skuLimpio);

        // 6. RESPUESTA FINAL
        if (resultado) {
            res.json({ status: 'ok', mensaje: 'Producto encontrado', data: resultado });
        } else {
            res.json({
                status: 'ok',
                mensaje: 'Agotado o No encontrado',
                data: { codigo: skuLimpio, stock: '0', precio: '-' }
            });
        }

    } catch (error) {
        console.error('ERROR FATAL:', error);
        res.status(500).json({ error: 'Error en el servidor', detalle: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(port, () => {
    console.log(`Servidor listo en puerto ${port}`);
});
